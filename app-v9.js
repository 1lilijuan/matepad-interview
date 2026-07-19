"use strict";

const $ = (id) => document.getElementById(id);
const KB = window.INTERVIEW_KB || [];
const TERM_GROUPS = window.TERM_GROUPS || [];
const APP_VERSION = window.APP_BUILD || "V9.0.0";
const MODEL_URL = "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-cn-0.3.tar.gz";

const SILENCE_TO_ANSWER_MS = 2500;
const RESULT_WAIT_MS = 850;
const MIN_SPEECH_MS = 650;

let model = null;
let recognizer = null;
let stream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let analyser = null;
let silentGain = null;
let meterFrame = null;
let wakeLock = null;

let listening = false;
let loading = false;
let finalizing = false;
let speechStarted = false;
let speechStartAt = 0;
let lastVoiceAt = 0;
let lastFinalizeAt = 0;
let modelTimer = null;
let finalizeTimer = null;
let partialText = "";
let finalParts = [];

function setStatus(text, mode = "") {
  $("status").textContent = text;
  $("lamp").className = "lamp" + (mode ? " " + mode : "");
}

function setDiagnostic(text) {
  $("partial").textContent = `${APP_VERSION}｜${text}`;
}

function collapseSpaces(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function simpleNormalize(text) {
  return collapseSpaces(String(text || "")
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：()（）【】\[\]{}"'`~]/g, " ")
    .replace(/[_/\\-]/g, " "));
}

function replaceAliases(rawText) {
  let corrected = ` ${simpleNormalize(rawText)} `;
  const detected = [];

  for (const group of TERM_GROUPS) {
    let found = false;
    const sortedAliases = [...group.aliases].sort((a, b) => b.length - a.length);
    for (const alias of sortedAliases) {
      const normalizedAlias = simpleNormalize(alias);
      if (!normalizedAlias) continue;

      if (corrected.includes(normalizedAlias)) {
        corrected = corrected.split(normalizedAlias).join(` ${group.term.toLowerCase()} `);
        found = true;
      } else {
        const compactText = corrected.replace(/\s+/g, "");
        const compactAlias = normalizedAlias.replace(/\s+/g, "");
        if (compactAlias.length >= 3 && compactText.includes(compactAlias)) {
          const escaped = compactAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          corrected = corrected.replace(new RegExp(escaped.split("").join("\\s*"), "gi"), ` ${group.term.toLowerCase()} `);
          found = true;
        }
      }
    }
    if (found) detected.push(group.term);
  }

  return {
    corrected: collapseSpaces(corrected),
    detected: [...new Set(detected)]
  };
}

function tokenizeEnglish(text) {
  return simpleNormalize(text)
    .split(/\s+/)
    .filter((token) =>
      token.length > 1 &&
      !["的","了","一下","请","介绍","怎么","如何","什么","为什么","这个","那个",
        "the","a","an","is","are","of","to","in","and","your","you","me","my","please"].includes(token)
    );
}

function chineseBigrams(text) {
  const chars = simpleNormalize(text).replace(/[a-z0-9\s]/g, "");
  const result = [];
  for (let i = 0; i < chars.length - 1; i += 1) result.push(chars.slice(i, i + 2));
  return result;
}

function diceCoefficient(aValues, bValues) {
  if (!aValues.length || !bValues.length) return 0;
  const counts = new Map();
  for (const item of aValues) counts.set(item, (counts.get(item) || 0) + 1);
  let intersection = 0;
  for (const item of bValues) {
    const count = counts.get(item) || 0;
    if (count > 0) {
      intersection += 1;
      counts.set(item, count - 1);
    }
  }
  return (2 * intersection) / (aValues.length + bValues.length);
}

function levenshteinSimilarity(a, b) {
  a = simpleNormalize(a);
  b = simpleNormalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length > 140 || b.length > 140) return 0;

  const previous = Array.from({length: b.length + 1}, (_, index) => index);
  const current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }

  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function scoreEntry(question, entry, detectedTerms) {
  const q = simpleNormalize(question);
  const phrases = [
    entry.name,
    entry.canonicalZh,
    entry.keywords,
    ...(entry.patterns || []),
    ...(entry.enPatterns || []),
    ...(entry.topicAliases || [])
  ].filter(Boolean);

  let score = 0;
  const qTokens = tokenizeEnglish(q);
  const qBigrams = chineseBigrams(q);

  for (const phrase of phrases) {
    const p = simpleNormalize(phrase);
    if (!p) continue;

    if (q.includes(p) || p.includes(q)) {
      score = Math.max(score, 70 + Math.min(25, Math.min(q.length, p.length)));
    }

    const tokenScore = diceCoefficient(qTokens, tokenizeEnglish(p));
    score = Math.max(score, tokenScore * 88);

    const bigramScore = diceCoefficient(qBigrams, chineseBigrams(p));
    score = Math.max(score, bigramScore * 94);

    score = Math.max(score, levenshteinSimilarity(q, p) * 74);
  }

  const searchableEntry = simpleNormalize(
    `${entry.name} ${entry.keywords} ${(entry.topicAliases || []).join(" ")} ${(entry.enPatterns || []).join(" ")}`
  );

  for (const term of detectedTerms) {
    const normalizedTerm = simpleNormalize(term);
    if (searchableEntry.includes(normalizedTerm)) score += 28;
  }

  return Math.min(100, score);
}

function chooseMatch(rawText) {
  const correctedData = replaceAliases(rawText);
  const corrected = correctedData.corrected;
  const detectedTerms = correctedData.detected;

  let best = null;
  let bestScore = -1;
  let secondScore = -1;

  for (const entry of KB) {
    const score = scoreEntry(corrected, entry, detectedTerms);
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = entry;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  const margin = Math.max(0, bestScore - secondScore);
  const confidence = Math.round(Math.min(99, bestScore * 0.84 + margin * 0.30));
  return {entry: best, score: bestScore, confidence, detectedTerms, corrected};
}

function genericAnswer(text) {
  const q = simpleNormalize(text);
  if (q.includes("axi") || q.includes("apb") || q.includes("总线")) {
    return {
      name: "总线与接口类通用问题",
      canonicalZh: "请介绍一下相关总线或接口模块的设计。",
      keywords: "接口作用｜握手｜状态机｜CDC｜异常处理",
      answer: "这个问题我会从接口作用、数据和控制流程、握手机制以及异常处理四个层面回答。模块首先接收并锁存上游请求，再通过仲裁、跨时钟或协议转换送到下游，最后等待响应并返回状态。设计时重点关注VALID/READY、请求不能丢失、多笔事务对应、复位和边界场景。"
    };
  }
  return {
    name: "通用项目问题",
    canonicalZh: collapseSpaces(text) || "请介绍一下这个项目问题。",
    keywords: "背景｜任务｜实现｜难点｜验证结果",
    answer: "这个问题在当前本地题库中没有高置信度的精确答案。我会先说明项目背景和目标，再明确我负责的任务；然后介绍数据流、控制流或状态机实现；接着说明关键难点及定位方法；最后给出仿真、综合、波形或芯片测试结果。"
  };
}

function renderAutomaticAnswer(rawText) {
  const raw = collapseSpaces(rawText);
  if (!raw) {
    setDiagnostic("没有得到有效文字，请靠近平板并连续说完整句子。");
    setStatus("本题没有识别出有效文字", "error");
    return;
  }

  $("rawText").textContent = raw;

  const match = chooseMatch(raw);
  const result = match.entry && match.score >= 22 ? match.entry : genericAnswer(match.corrected);
  $("correctedTerms").textContent = match.detectedTerms.length
    ? `已恢复专业术语：${match.detectedTerms.join("、")}`
    : "未检测到需要纠正的英文专业术语";

  $("question").value = result.canonicalZh || match.corrected;
  $("matched").textContent = `自动语义匹配：${result.name}`;
  $("keywords").textContent = result.keywords;
  $("answer").textContent = result.answer;

  const level = match.score >= 70 ? "高" : match.score >= 45 ? "中" : "低";
  $("confidence").textContent =
    `匹配置信度：${level}（${Math.round(match.score)}分）｜老师原话已自动归一化为标准问题`;

  setDiagnostic(`已自动生成回答：${result.canonicalZh || match.corrected}`);
  setStatus(listening ? "回答已生成，继续等待下一题" : "回答已生成", listening ? "on" : "");
}

function resetBuffers() {
  partialText = "";
  finalParts = [];
  finalizing = false;
  speechStarted = false;
  speechStartAt = 0;
  lastVoiceAt = 0;
}

function updatePartialDisplay() {
  const current = collapseSpaces([...finalParts, partialText].join(" "));
  if (current) {
    $("rawText").textContent = current;
    const correctedData = replaceAliases(current);
    $("correctedTerms").textContent = correctedData.detected.length
      ? `正在识别专业术语：${correctedData.detected.join("、")}`
      : "正在识别中文问题……";
    setDiagnostic(`实时识别：${current}`);
    setStatus("正在识别老师的问题", "on");
  }
}

function createRecognizer(sampleRate) {
  recognizer = new model.KaldiRecognizer(sampleRate);

  recognizer.on("partialresult", (message) => {
    partialText = collapseSpaces(message?.result?.partial || "");
    updatePartialDisplay();
  });

  recognizer.on("result", (message) => {
    const text = collapseSpaces(message?.result?.text || "");
    partialText = "";
    if (text) finalParts.push(text);
    updatePartialDisplay();
  });

  recognizer.on("error", (message) => {
    console.error("Recognizer error", message);
    setDiagnostic("识别器错误：" + (message?.error || "未知错误"));
    setStatus("本地识别器错误", "error");
  });
}

async function loadModel() {
  if (loading || model) return;
  loading = true;
  $("loadModel").disabled = true;
  $("progressBar").className = "loading";
  const startedAt = Date.now();

  modelTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    $("modelInfo").textContent = `正在加载中文模型，已等待${seconds}秒。请保持页面前台并不要锁屏。`;
  }, 1000);

  try {
    if (!window.Vosk?.createModel) throw new Error("Vosk程序未加载，请检查网络。");
    setStatus("正在加载中文语音模型", "busy");
    model = await window.Vosk.createModel(MODEL_URL);
    clearInterval(modelTimer);
    $("progressBar").className = "";
    $("progressBar").style.width = "100%";
    $("modelInfo").textContent =
      "中文模型已加载完成。英文术语将通过本地发音别名和简历语义题库自动恢复。";
    $("start").disabled = false;
    setStatus("中文术语增强模型已就绪", "on");
  } catch (error) {
    clearInterval(modelTimer);
    console.error(error);
    $("progressBar").className = "";
    $("loadModel").disabled = false;
    $("modelInfo").textContent = "模型加载失败：" + (error?.message || String(error));
    setStatus("模型加载失败，请重试", "error");
  } finally {
    loading = false;
  }
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (error) {
    console.warn("Wake lock unavailable", error);
  }
}

function finalizeCurrentQuestion(reason = "检测到停顿") {
  if (!listening || finalizing || !recognizer) return;
  if (!finalParts.length && !partialText) return;

  finalizing = true;
  lastFinalizeAt = Date.now();
  const preFinalText = collapseSpaces([...finalParts, partialText].join(" "));
  setStatus(`${reason}，正在整理完整问题`, "busy");
  setDiagnostic(`${reason}，正在获取最终识别结果……`);

  try { recognizer.retrieveFinalResult(); } catch (error) { console.warn(error); }

  clearTimeout(finalizeTimer);
  finalizeTimer = setTimeout(() => {
    const finalText = collapseSpaces([...finalParts, partialText].join(" ")) || preFinalText;
    renderAutomaticAnswer(finalText);
    resetBuffers();
  }, RESULT_WAIT_MS);
}

function updateMeter() {
  if (!listening || !analyser) return;

  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const value of data) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }
  const rms = Math.sqrt(sum / data.length);
  $("meterFill").style.width = `${Math.min(100, Math.max(1, rms * 650))}%`;

  const now = Date.now();
  if (rms >= 0.014) {
    if (!speechStarted) {
      speechStarted = true;
      speechStartAt = now;
    }
    lastVoiceAt = now;
    if (rms < 0.035) $("levelText").textContent = "收到较小声音";
    else if (rms < 0.09) $("levelText").textContent = "正在收到清晰人声";
    else $("levelText").textContent = "声音较大";
  } else {
    $("levelText").textContent = "环境较安静";
    const spokeLongEnough = speechStarted && now - speechStartAt >= MIN_SPEECH_MS;
    const silenceLongEnough = lastVoiceAt && now - lastVoiceAt >= SILENCE_TO_ANSWER_MS;
    const notRecentlyFinalized = now - lastFinalizeAt >= SILENCE_TO_ANSWER_MS;
    if (spokeLongEnough && silenceLongEnough && notRecentlyFinalized && !finalizing) {
      finalizeCurrentQuestion("已等待约2.5秒");
    }
  }

  meterFrame = requestAnimationFrame(updateMeter);
}

async function startListening() {
  if (!model) {
    setStatus("请先加载中文模型", "error");
    return;
  }
  if (listening) return;

  try {
    setStatus("正在申请麦克风权限", "busy");
    stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 16000
      }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    createRecognizer(audioContext.sampleRate);

    sourceNode = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.18;

    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    processorNode.onaudioprocess = (event) => {
      if (!listening || !recognizer) return;
      try {
        recognizer.acceptWaveform(event.inputBuffer);
        event.outputBuffer.getChannelData(0).fill(0);
      } catch (error) {
        console.error("acceptWaveform failed", error);
        setDiagnostic("音频送入识别器失败：" + (error?.message || String(error)));
        setStatus("识别处理失败", "error");
      }
    };

    sourceNode.connect(analyser);
    sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    listening = true;
    resetBuffers();
    $("start").disabled = true;
    $("stop").disabled = false;
    $("forceResult").disabled = false;
    $("levelText").textContent = "麦克风已打开";
    setDiagnostic(`中文识别器已创建，实际采样率${audioContext.sampleRate}Hz。请说完整问题。`);
    setStatus(`${APP_VERSION} 正在持续监听`, "on");
    await requestWakeLock();
    updateMeter();
  } catch (error) {
    console.error(error);
    setDiagnostic("麦克风启动失败：" + (error?.message || String(error)));
    setStatus("麦克风启动失败", "error");
    await stopListening();
  }
}

async function stopListening() {
  listening = false;
  clearTimeout(finalizeTimer);
  clearInterval(modelTimer);

  if (meterFrame) cancelAnimationFrame(meterFrame);
  meterFrame = null;

  if (processorNode) {
    processorNode.onaudioprocess = null;
    try { processorNode.disconnect(); } catch {}
  }
  try { sourceNode?.disconnect(); } catch {}
  try { analyser?.disconnect(); } catch {}
  try { silentGain?.disconnect(); } catch {}
  stream?.getTracks().forEach((track) => track.stop());

  try { recognizer?.remove(); } catch {}
  try { await audioContext?.close(); } catch {}
  try { await wakeLock?.release(); } catch {}

  recognizer = null;
  stream = null;
  audioContext = null;
  sourceNode = null;
  processorNode = null;
  analyser = null;
  silentGain = null;
  wakeLock = null;
  resetBuffers();

  $("meterFill").style.width = "0";
  $("levelText").textContent = "麦克风已关闭";
  $("start").disabled = !model;
  $("stop").disabled = true;
  $("forceResult").disabled = true;
  setDiagnostic("监听已停止。");
  setStatus("监听已停止，模型仍可继续使用");
}

function rematchCurrentText() {
  const text = collapseSpaces($("question").value || $("rawText").textContent);
  if (text && text !== "—") renderAutomaticAnswer(text);
}

$("loadModel").addEventListener("click", loadModel);
$("start").addEventListener("click", startListening);
$("stop").addEventListener("click", stopListening);
$("forceResult").addEventListener("click", () => finalizeCurrentQuestion("手动结束本题"));
$("manualAnswer").addEventListener("click", rematchCurrentText);
$("manualInput").addEventListener("click", () => {
  const value = prompt("请输入老师的问题：", $("question").value);
  if (value !== null) renderAutomaticAnswer(value);
});
$("clear").addEventListener("click", () => {
  resetBuffers();
  $("rawText").textContent = "—";
  $("correctedTerms").textContent = "等待识别专业术语";
  $("question").value = "";
  $("confidence").textContent = "等待语义匹配";
  $("matched").textContent = "等待完整问题";
  $("keywords").textContent = "关键词提示会显示在这里";
  $("answer").textContent = "老师说完并停顿约2.5秒后，回答会自动出现。";
  setDiagnostic(listening ? "等待老师说话……" : "等待开始监听……");
});
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("answer").textContent);
    setStatus("回答已复制", listening ? "on" : "");
  } catch {
    setStatus("复制失败，请长按文字复制", "error");
  }
});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && listening && !wakeLock) await requestWakeLock();
});

if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
  $("start").disabled = true;
  setStatus("当前浏览器不支持麦克风或Web Audio", "error");
}

setStatus(`${APP_VERSION} 已加载，请先加载中文模型`, "on");
