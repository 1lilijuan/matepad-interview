"use strict";

const $ = id => document.getElementById(id);
const KB = window.INTERVIEW_KB || [];
const DOMAIN_GRAMMAR = window.DOMAIN_GRAMMAR || ["[unk]"];
const TERM_ALIASES = window.TERM_ALIASES || [];
const APP_VERSION = window.APP_BUILD || "V12.0.0";
const MODEL_URL = "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-cn-0.3.tar.gz";

const SILENCE_MS = 2300;
const FINAL_WAIT_MS = 700;
const MIN_SPEECH_MS = 600;

let model = null;
let recognizer = null;
let stream = null;
let audioContext = null;
let sourceNode = null;
let highPassNode = null;
let processorNode = null;
let analyser = null;
let silentGain = null;
let wakeLock = null;
let meterFrame = null;

let listening = false;
let loading = false;
let finalizing = false;
let partialText = "";
let finalParts = [];
let speechStarted = false;
let speechStartAt = 0;
let lastVoiceAt = 0;
let lastFinalizeAt = 0;
let finalizeTimer = null;
let modelTimer = null;

function setStatus(text, mode = "") {
  $("status").textContent = text;
  $("lamp").className = "lamp" + (mode ? " " + mode : "");
}

function setDiagnostic(text) {
  $("partial").textContent = `${APP_VERSION}｜${text}`;
}

function compact(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}

function normalized(text) {
  return compact(text)
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：()（）【】\[\]{}"'`~_\-/\\]/g, "");
}

function restoreTerms(rawText) {
  let output = compact(rawText);
  const detected = [];

  for (const group of TERM_ALIASES) {
    const canonical = group[0];
    const aliases = group.slice(1);
    let hit = false;

    for (const alias of [canonical, ...aliases]) {
      const key = normalized(alias);
      if (!key) continue;
      const current = normalized(output);
      if (current.includes(key)) {
        // Direct replacement works for both spaced Vosk output and compact Chinese output.
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        output = output.replace(new RegExp(escaped.replace(/\s+/g, "\\s*"), "gi"), canonical);
        hit = true;
      }
    }

    if (hit) detected.push(canonical);
  }

  // Compact-output fallbacks for common letter-name pronunciations.
  const direct = [
    [/鸡皮鸡皮油|机皮机皮优|吉皮吉皮优|基皮基皮优/gi, "GPGPU"],
    [/鸡皮油|机皮优/gi, "GPU"],
    [/艾克西|爱克西|埃克西|阿克西|艾克赛/gi, "AXI"],
    [/艾皮比|爱皮比|阿皮比/gi, "APB"],
    [/皮提皮艾克斯|皮提皮叉/gi, "PTPX"],
    [/西迪西/gi, "CDC"],
    [/飞否|非否|菲佛/gi, "FIFO"],
    [/艾斯迪西/gi, "SDC"],
    [/优皮艾夫/gi, "UPF"],
    [/恩皮优/gi, "NPU"],
    [/恩欧西/gi, "NoC"],
    [/瑞斯克五/gi, "RISC-V"],
    [/班克控制器|板块控制器/gi, "bank_controller"]
  ];
  for (const [pattern, replacement] of direct) {
    if (pattern.test(output)) {
      output = output.replace(pattern, replacement);
      detected.push(replacement);
    }
  }

  return { text: output, detected: [...new Set(detected)] };
}

function bigrams(text) {
  const value = normalized(text);
  const result = [];
  for (let i = 0; i < value.length - 1; i += 1) result.push(value.slice(i, i + 2));
  return result;
}

function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  for (const item of a) counts.set(item, (counts.get(item) || 0) + 1);
  let intersection = 0;
  for (const item of b) {
    const count = counts.get(item) || 0;
    if (count > 0) {
      intersection += 1;
      counts.set(item, count - 1);
    }
  }
  return 2 * intersection / (a.length + b.length);
}

function scoreEntry(question, entry) {
  const q = normalized(question);
  const qBigrams = bigrams(q);
  let score = 0;

  const phrases = [
    entry.name,
    entry.canonical,
    entry.keywords,
    ...(entry.patterns || []),
    ...(entry.domainPhrases || [])
  ].filter(Boolean);

  for (const phrase of phrases) {
    const p = normalized(phrase);
    if (!p) continue;
    if (q.includes(p) || p.includes(q)) {
      score = Math.max(score, 72 + Math.min(25, Math.min(q.length, p.length)));
    }
    score = Math.max(score, dice(qBigrams, bigrams(p)) * 94);
  }

  return Math.min(100, score);
}

function chooseAnswer(question) {
  let best = null;
  let bestScore = -1;
  let second = -1;

  for (const entry of KB) {
    const score = scoreEntry(question, entry);
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = entry;
    } else if (score > second) {
      second = score;
    }
  }

  return { entry: best, score: bestScore, margin: Math.max(0, bestScore - second) };
}

function genericAnswer(question) {
  return {
    name: "题库外问题",
    canonical: question,
    keywords: "背景｜任务｜实现方法｜难点｜验证结果",
    answer: "这个问题没有与当前题库形成可靠匹配。我会先说明项目背景和目标，再明确我负责的任务；然后介绍数据流、控制流或状态机实现；接着说明关键难点和解决方法；最后给出仿真、综合、波形或芯片测试结果。"
  };
}

function renderAnswer(rawText) {
  const raw = compact(rawText);
  if (!raw) {
    setDiagnostic("本题没有识别到有效文字，请靠近平板再试。");
    setStatus("本题没有识别到文字", "error");
    return;
  }

  $("rawText").textContent = raw;
  const restored = restoreTerms(raw);
  $("termInfo").textContent = restored.detected.length
    ? `已恢复：${restored.detected.join("、")}`
    : "没有发现需要恢复的英文专业术语";

  const match = chooseAnswer(restored.text);
  const result = match.entry && match.score >= 24 ? match.entry : genericAnswer(restored.text);

  $("question").value = result.canonical || restored.text;
  $("matched").textContent = `问题匹配：${result.name}`;
  $("keywords").textContent = result.keywords;
  $("answer").textContent = result.answer;

  const level = match.score >= 72 ? "高" : match.score >= 46 ? "中" : "低";
  $("confidence").textContent =
    `匹配置信度：${level}（${Math.round(match.score)}分）｜当前模式：${$("recognitionMode").value === "domain" ? "面试增强" : "自由中文"}`;

  setDiagnostic(`已经自动回答：${result.canonical || restored.text}`);
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

function updatePartial() {
  const current = compact([...finalParts, partialText].join(""));
  if (!current) return;
  $("rawText").textContent = current;
  const restored = restoreTerms(current);
  $("termInfo").textContent = restored.detected.length
    ? `实时检测到：${restored.detected.join("、")}`
    : "正在识别中文问题";
  setDiagnostic(`实时识别：${current}`);
  setStatus("正在识别老师的问题", "on");
}

function createRecognizer(sampleRate) {
  const mode = $("recognitionMode").value;
  if (mode === "domain") {
    try {
      recognizer = new model.KaldiRecognizer(sampleRate, JSON.stringify(DOMAIN_GRAMMAR));
      setDiagnostic(`面试增强识别器已创建，采样率${sampleRate}Hz，语法短语${DOMAIN_GRAMMAR.length}条。`);
    } catch (error) {
      console.warn("Domain grammar unavailable, fallback to free recognition", error);
      recognizer = new model.KaldiRecognizer(sampleRate);
      $("recognitionMode").value = "free";
      setDiagnostic(`增强语法不可用，已自动回退到自由中文识别，采样率${sampleRate}Hz。`);
    }
  } else {
    recognizer = new model.KaldiRecognizer(sampleRate);
    setDiagnostic(`自由中文识别器已创建，采样率${sampleRate}Hz。`);
  }

  recognizer.on("partialresult", message => {
    partialText = compact(message?.result?.partial || "");
    updatePartial();
  });

  recognizer.on("result", message => {
    const text = compact(message?.result?.text || "");
    partialText = "";
    if (text) finalParts.push(text);
    updatePartial();
  });

  recognizer.on("error", message => {
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
  const started = Date.now();

  modelTimer = setInterval(() => {
    $("modelInfo").textContent = `正在加载V7同款快速中文模型，已等待${Math.floor((Date.now() - started) / 1000)}秒。`;
  }, 1000);

  try {
    if (!window.Vosk?.createModel) throw new Error("Vosk程序未加载，请检查网络。");
    setStatus("正在加载快速中文模型", "busy");
    model = await window.Vosk.createModel(MODEL_URL);
    clearInterval(modelTimer);
    $("progressBar").className = "";
    $("progressBar").style.width = "100%";
    $("modelInfo").textContent =
      "模型已加载。开始监听时会根据所选模式创建增强识别器或自由中文识别器。";
    $("start").disabled = false;
    $("recognitionMode").disabled = false;
    setStatus("快速中文模型已就绪", "on");
  } catch (error) {
    clearInterval(modelTimer);
    console.error(error);
    $("progressBar").className = "";
    $("loadModel").disabled = false;
    $("modelInfo").textContent = "模型加载失败：" + (error?.message || String(error));
    setStatus("模型加载失败", "error");
  } finally {
    loading = false;
  }
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch {}
}

function finalizeQuestion(reason = "检测到停顿") {
  if (!listening || finalizing || !recognizer) return;
  if (!finalParts.length && !partialText) return;

  finalizing = true;
  lastFinalizeAt = Date.now();
  const backup = compact([...finalParts, partialText].join(""));
  setStatus(`${reason}，正在整理问题`, "busy");
  setDiagnostic(`${reason}，正在取得最终结果……`);

  try { recognizer.retrieveFinalResult(); } catch (error) { console.warn(error); }

  clearTimeout(finalizeTimer);
  finalizeTimer = setTimeout(() => {
    const finalText = compact([...finalParts, partialText].join("")) || backup;
    renderAnswer(finalText);
    resetBuffers();
  }, FINAL_WAIT_MS);
}

function updateMeter() {
  if (!listening || !analyser) return;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);

  let sum = 0;
  for (const value of data) {
    const x = (value - 128) / 128;
    sum += x * x;
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
    const longEnough = speechStarted && now - speechStartAt >= MIN_SPEECH_MS;
    const silentEnough = lastVoiceAt && now - lastVoiceAt >= SILENCE_MS;
    const notRecent = now - lastFinalizeAt >= SILENCE_MS;
    if (longEnough && silentEnough && notRecent && !finalizing) {
      finalizeQuestion("已等待约2.3秒");
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
    highPassNode = audioContext.createBiquadFilter();
    highPassNode.type = "highpass";
    highPassNode.frequency.value = 70;
    highPassNode.Q.value = 0.7;

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.18;

    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    processorNode.onaudioprocess = event => {
      if (!listening || !recognizer) return;
      try {
        recognizer.acceptWaveform(event.inputBuffer);
        event.outputBuffer.getChannelData(0).fill(0);
      } catch (error) {
        console.error(error);
        setDiagnostic("音频识别失败：" + (error?.message || String(error)));
      }
    };

    sourceNode.connect(highPassNode);
    highPassNode.connect(analyser);
    highPassNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    listening = true;
    resetBuffers();
    $("start").disabled = true;
    $("stop").disabled = false;
    $("forceResult").disabled = false;
    $("recognitionMode").disabled = true;
    $("levelText").textContent = "麦克风已打开";
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
  if (meterFrame) cancelAnimationFrame(meterFrame);
  meterFrame = null;

  if (processorNode) {
    processorNode.onaudioprocess = null;
    try { processorNode.disconnect(); } catch {}
  }
  try { highPassNode?.disconnect(); } catch {}
  try { sourceNode?.disconnect(); } catch {}
  try { analyser?.disconnect(); } catch {}
  try { silentGain?.disconnect(); } catch {}
  stream?.getTracks().forEach(track => track.stop());

  try { recognizer?.remove(); } catch {}
  try { await audioContext?.close(); } catch {}
  try { await wakeLock?.release(); } catch {}

  recognizer = null;
  stream = null;
  audioContext = null;
  sourceNode = null;
  highPassNode = null;
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
  $("recognitionMode").disabled = false;
  setDiagnostic("监听已停止。");
  setStatus("监听已停止，模型仍可使用");
}

function rematchText() {
  const text = $("question").value || $("rawText").textContent;
  if (text && text !== "—") renderAnswer(text);
}

$("recognitionMode").addEventListener("change", () => {
  $("modeHelp").textContent = $("recognitionMode").value === "domain"
    ? "增强模式会在声学解码阶段优先识别简历相关问题和专业术语，并保留[unk]处理未收录内容。"
    : "自由模式不限制问题范围，表达更自由，但GPGPU、AXI等术语可能更容易被听错。";
});
$("loadModel").addEventListener("click", loadModel);
$("start").addEventListener("click", startListening);
$("stop").addEventListener("click", stopListening);
$("forceResult").addEventListener("click", () => finalizeQuestion("手动结束本题"));
$("manualAnswer").addEventListener("click", rematchText);
$("manualInput").addEventListener("click", () => {
  const value = prompt("请输入老师的问题：", $("question").value);
  if (value !== null) renderAnswer(value);
});
$("clear").addEventListener("click", () => {
  resetBuffers();
  $("rawText").textContent = "—";
  $("termInfo").textContent = "等待识别";
  $("question").value = "";
  $("confidence").textContent = "等待问题匹配";
  $("matched").textContent = "等待完整问题";
  $("keywords").textContent = "关键词提示会显示在这里";
  $("answer").textContent = "老师说完并停顿后，回答会自动出现。";
  setDiagnostic(listening ? "等待老师说话……" : "等待开始监听……");
});
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("answer").textContent);
    setStatus("回答已复制", listening ? "on" : "");
  } catch {
    setStatus("复制失败，请长按回答文字复制", "error");
  }
});

if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
  $("start").disabled = true;
  setStatus("当前浏览器不支持麦克风或Web Audio", "error");
}

setStatus(`${APP_VERSION} 已加载，请先加载中文模型`, "on");
