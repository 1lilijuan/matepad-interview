"use strict";

const $ = (id) => document.getElementById(id);
const KB = window.INTERVIEW_KB || [];
const TERM_GROUPS = window.TERM_GROUPS || [];
const APP_VERSION = window.APP_BUILD || "V11.0.0";

const TARGET_RATE = 16000;
const SILENCE_MS = 2500;
const MIN_SPEECH_MS = 700;
const MAX_SEGMENT_MS = 15000;
const PRE_ROLL_MS = 300;

let worker = null;
let workerReady = false;
let workerBusy = false;
let loadingModel = false;

let stream = null;
let audioContext = null;
let sourceNode = null;
let highPassNode = null;
let processorNode = null;
let silentGain = null;
let wakeLock = null;

let listening = false;
let latestRms = 0;
let noiseFloor = 0.006;
let voiceThreshold = 0.014;
let meterFrame = null;

let segmentActive = false;
let segmentChunks = [];
let preRollChunks = [];
let segmentStartAt = 0;
let lastVoiceAt = 0;
let speechDetectedAt = 0;

let transcriptionQueue = [];
let nextTaskId = 1;

function setStatus(text, mode = "") {
  $("status").textContent = text;
  $("lamp").className = "lamp" + (mode ? " " + mode : "");
}

function setDiagnostic(text) {
  $("diagnostic").textContent = `${APP_VERSION}｜${text}`;
}

function updateQueueText() {
  $("queueText").textContent = String(transcriptionQueue.length + (workerBusy ? 1 : 0));
}

function collapseSpaces(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeBasic(text) {
  return collapseSpaces(
    String(text || "")
      .toLowerCase()
      .replace(/[，。！？、,.!?;；:：()（）【】\[\]{}"'`~]/g, " ")
      .replace(/[_/\\-]/g, " ")
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTechnicalTerms(rawText) {
  let corrected = ` ${normalizeBasic(rawText)} `;
  const detected = [];

  for (const group of TERM_GROUPS) {
    let found = false;
    const aliases = [...(group.aliases || []), group.term].sort((a, b) => b.length - a.length);

    for (const alias of aliases) {
      const normalizedAlias = normalizeBasic(alias);
      if (!normalizedAlias) continue;

      if (corrected.includes(normalizedAlias)) {
        corrected = corrected.replace(new RegExp(escapeRegExp(normalizedAlias), "gi"), ` ${group.term} `);
        found = true;
      }
    }
    if (found) detected.push(group.term);
  }

  corrected = collapseSpaces(corrected)
    .replace(/\bg p g p u\b/gi, "GPGPU")
    .replace(/\ba x i\b/gi, "AXI")
    .replace(/\ba p b\b/gi, "APB")
    .replace(/\bp t p x\b/gi, "PTPX")
    .replace(/\bc d c\b/gi, "CDC")
    .replace(/\bf i f o\b/gi, "FIFO")
    .replace(/\br m w\b/gi, "RMW")
    .replace(/\bs d c\b/gi, "SDC")
    .replace(/\bu p f\b/gi, "UPF")
    .replace(/\bf s d b\b/gi, "FSDB")
    .replace(/\br t l\b/gi, "RTL")
    .replace(/\bn p u\b/gi, "NPU")
    .replace(/\bd r a m\b/gi, "DRAM");

  return { corrected, detected: [...new Set(detected)] };
}

function tokens(text) {
  return normalizeBasic(text)
    .split(/\s+/)
    .filter(token => token.length > 1 && ![
      "请","一下","介绍","什么","怎么","如何","为什么","这个","那个","你的","项目",
      "the","a","an","is","are","of","to","in","and","your","you","please"
    ].includes(token));
}

function chineseBigrams(text) {
  const value = normalizeBasic(text).replace(/[a-z0-9\s]/g, "");
  const output = [];
  for (let i = 0; i < value.length - 1; i += 1) output.push(value.slice(i, i + 2));
  return output;
}

function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const map = new Map();
  for (const item of a) map.set(item, (map.get(item) || 0) + 1);
  let intersection = 0;
  for (const item of b) {
    const count = map.get(item) || 0;
    if (count > 0) {
      intersection += 1;
      map.set(item, count - 1);
    }
  }
  return (2 * intersection) / (a.length + b.length);
}

function scoreEntry(question, entry) {
  const q = normalizeBasic(question);
  const qTokens = tokens(q);
  const qBigrams = chineseBigrams(q);

  const phrases = [
    entry.name,
    entry.canonicalZh,
    entry.keywords,
    ...(entry.patterns || []),
    ...(entry.enPatterns || []),
    ...(entry.topicAliases || [])
  ].filter(Boolean);

  let score = 0;
  for (const phrase of phrases) {
    const p = normalizeBasic(phrase);
    if (!p) continue;

    if (q.includes(p) || p.includes(q)) {
      score = Math.max(score, 72 + Math.min(24, Math.min(q.length, p.length)));
    }
    score = Math.max(score, dice(qTokens, tokens(p)) * 88);
    score = Math.max(score, dice(qBigrams, chineseBigrams(p)) * 94);
  }
  return Math.min(100, score);
}

function findBestAnswer(question) {
  let best = null;
  let bestScore = -1;
  let secondScore = -1;

  for (const entry of KB) {
    const score = scoreEntry(question, entry);
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = entry;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  return {
    entry: best,
    score: bestScore,
    margin: Math.max(0, bestScore - secondScore)
  };
}

function genericAnswer(question) {
  const q = normalizeBasic(question);
  if (q.includes("axi") || q.includes("apb") || q.includes("总线")) {
    return {
      name: "总线与接口类问题",
      keywords: "接口作用｜握手｜状态机｜CDC｜异常处理",
      answer: "这个问题我会从接口作用、数据和控制流程、握手机制以及异常处理四个层面回答。模块首先接收并锁存上游请求，再通过仲裁、跨时钟或协议转换送到下游，最后等待响应并返回状态。设计时重点关注VALID/READY、请求不能丢失、多笔事务对应、复位和边界场景。"
    };
  }
  return {
    name: "未精确匹配的项目问题",
    keywords: "背景｜任务｜实现｜难点｜验证结果",
    answer: "这个问题没有与当前本地题库形成高置信度匹配。我会先说明项目背景和目标，再明确我负责的任务；然后介绍数据流、控制流或状态机实现；接着说明关键难点及定位方法；最后给出仿真、综合、波形或芯片测试结果。"
  };
}

function renderTranscript(rawText, metadata = {}) {
  const raw = collapseSpaces(rawText);
  $("rawText").textContent = raw || "没有识别到有效文字";

  if (!raw) {
    $("question").value = "";
    $("termInfo").textContent = "本次音频没有得到有效转写，请调整距离或模型。";
    setStatus("本题没有识别到有效文字", "error");
    return;
  }

  const termResult = normalizeTechnicalTerms(raw);
  $("question").value = termResult.corrected;
  $("termInfo").textContent = termResult.detected.length
    ? `已规范专业术语：${termResult.detected.join("、")}`
    : "Whisper未发现需要额外规范的专业术语";

  const match = findBestAnswer(termResult.corrected);
  const result = match.entry && match.score >= 29 ? match.entry : genericAnswer(termResult.corrected);
  const elapsedSeconds = Number(metadata.elapsedMs || 0) / 1000;

  $("matched").textContent =
    `答案匹配：${result.name}｜匹配分数 ${Math.round(match.score)}｜转写耗时 ${elapsedSeconds.toFixed(1)}秒`;
  $("keywords").textContent = result.keywords;
  $("answer").textContent = result.answer;

  setDiagnostic(`Whisper完成转写：${termResult.corrected}`);
  setStatus(listening ? "回答已生成，继续等待下一题" : "回答已生成", listening ? "on" : "");
}

function concatenateChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function resampleTo16k(input, inputRate) {
  if (inputRate === TARGET_RATE) return input;

  if (inputRate < TARGET_RATE) {
    const outputLength = Math.max(1, Math.round(input.length * TARGET_RATE / inputRate));
    const output = new Float32Array(outputLength);
    const ratio = inputRate / TARGET_RATE;
    for (let i = 0; i < outputLength; i += 1) {
      const position = i * ratio;
      const left = Math.floor(position);
      const right = Math.min(input.length - 1, left + 1);
      const fraction = position - left;
      output[i] = input[left] * (1 - fraction) + input[right] * fraction;
    }
    return output;
  }

  const ratio = inputRate / TARGET_RATE;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += input[j];
      count += 1;
    }
    output[i] = count ? sum / count : input[Math.min(start, input.length - 1)];
  }
  return output;
}

function enqueueSegment(chunks, reason) {
  if (!chunks.length || !audioContext) return;

  if (workerBusy || transcriptionQueue.length > 0) {
    setDiagnostic("Whisper正在处理上一题，为避免内存不足，本段音频未加入队列。");
    return;
  }

  const merged = concatenateChunks(chunks);
  const resampled = resampleTo16k(merged, audioContext.sampleRate);
  const audioSeconds = resampled.length / TARGET_RATE;

  if (audioSeconds < 0.55) {
    setDiagnostic("检测到的声音太短，已忽略。");
    return;
  }

  transcriptionQueue.push({
    id: nextTaskId++,
    audio: resampled,
    audioSeconds,
    reason
  });
  updateQueueText();
  setDiagnostic(`已截取${audioSeconds.toFixed(1)}秒问题，等待Whisper转写。`);
  processQueue();
}

function finishCurrentSegment(reason) {
  if (!segmentActive) return;
  const chunks = segmentChunks;
  segmentActive = false;
  segmentChunks = [];
  segmentStartAt = 0;
  lastVoiceAt = 0;
  speechDetectedAt = 0;
  enqueueSegment(chunks, reason);
}

function processQueue() {
  if (!workerReady || workerBusy || !transcriptionQueue.length) return;

  const task = transcriptionQueue.shift();
  workerBusy = true;
  updateQueueText();
  setStatus(`正在用低内存Whisper转写第${task.id}个问题，暂不收下一题`, "busy");
  setDiagnostic(`Whisper正在处理${task.audioSeconds.toFixed(1)}秒音频，请稍候……`);

  const buffer = task.audio.buffer;
  worker.postMessage({
    type: "transcribe",
    id: task.id,
    audio: buffer,
    audioSeconds: task.audioSeconds,
    language: $("languageSelect").value
  }, [buffer]);
}

function createWorker() {
  if (worker) worker.terminate();
  worker = new Worker("./whisper-worker-v11.js?v=11.0.0", { type: "module" });

  worker.addEventListener("message", event => {
    const message = event.data || {};

    if (message.type === "progress") {
      const progress = message.progress || {};
      const numericProgress = Number(progress.progress);
      if (Number.isFinite(numericProgress)) {
        $("progressBar").className = "";
        $("progressBar").style.width = `${Math.max(0, Math.min(100, numericProgress))}%`;
      }
      const file = progress.file || progress.name || progress.status || "模型文件";
      $("progressText").textContent = Number.isFinite(numericProgress)
        ? `${file}：${numericProgress.toFixed(1)}%`
        : String(file);
    } else if (message.type === "ready") {
      workerReady = true;
      loadingModel = false;
      $("progressBar").className = "";
      $("progressBar").style.width = "100%";
      $("progressText").textContent = "Whisper模型加载完成，并已保存在浏览器缓存中";
      $("modelInfo").textContent = "模型已就绪。现在可以打开麦克风。以后再次加载通常会直接读取浏览器缓存。";
      $("modelSelect").disabled = true;
      $("languageSelect").disabled = false;
      $("loadModel").disabled = true;
      $("start").disabled = false;
      setStatus("Whisper模型已就绪", "on");
      processQueue();
    } else if (message.type === "result") {
      workerBusy = false;
      updateQueueText();
      renderTranscript(message.text, message);
      processQueue();
    } else if (message.type === "error") {
      workerBusy = false;
      loadingModel = false;
      updateQueueText();
      console.error(message);
      setDiagnostic(`Whisper错误：${message.message}`);
      setStatus("Whisper模型或转写失败", "error");
      $("loadModel").disabled = false;
      if (message.stage === "load") {
        $("modelSelect").disabled = false;
        $("languageSelect").disabled = false;
        $("progressBar").className = "";
        $("progressBar").style.width = "0";
        $("progressText").textContent = "加载失败。请重新启动平板和浏览器，并优先选择Whisper Tiny Q4。";
      }
      processQueue();
    }
  });

  worker.addEventListener("error", event => {
    console.error(event);
    loadingModel = false;
    workerReady = false;
    setDiagnostic(`Worker启动失败：${event.message || "未知错误"}`);
    setStatus("Whisper Worker启动失败", "error");
    $("loadModel").disabled = false;
    $("modelSelect").disabled = false;
  });
}

async function loadWhisper() {
  if (loadingModel || workerReady) return;
  loadingModel = true;
  $("loadModel").disabled = true;
  $("modelSelect").disabled = true;
  $("languageSelect").disabled = true;
  $("progressBar").style.width = "0";
  $("progressBar").className = "loading";
  $("progressText").textContent = "正在初始化Transformers.js和ONNX Runtime……";
  setStatus("正在下载并加载Whisper模型", "busy");

  createWorker();
  worker.postMessage({
    type: "load",
    modelId: $("modelSelect").value
  });
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (error) {
    console.warn("无法保持屏幕常亮", error);
  }
}

function computeRms(data) {
  let sum = 0;
  for (const sample of data) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, data.length));
}

function handleAudioChunk(inputData) {
  const now = performance.now();
  latestRms = computeRms(inputData);

  // Mobile low-memory mode: do not allocate/copy audio while Whisper is running.
  if (workerBusy) {
    return;
  }

  const chunk = new Float32Array(inputData);

  if (!segmentActive) {
    noiseFloor = noiseFloor * 0.985 + latestRms * 0.015;
    voiceThreshold = Math.max(0.011, Math.min(0.045, noiseFloor * 3.1));

    preRollChunks.push(chunk);
    const maxPreRollChunks = Math.max(2, Math.ceil((PRE_ROLL_MS / 1000) * audioContext.sampleRate / chunk.length));
    while (preRollChunks.length > maxPreRollChunks) preRollChunks.shift();

    if (latestRms >= voiceThreshold) {
      segmentActive = true;
      segmentStartAt = now;
      speechDetectedAt = now;
      lastVoiceAt = now;
      segmentChunks = [...preRollChunks];
      preRollChunks = [];
      setStatus("检测到老师开始说话", "on");
    }
    return;
  }

  segmentChunks.push(chunk);

  if (latestRms >= voiceThreshold * 0.80) {
    lastVoiceAt = now;
  }

  const segmentDuration = now - segmentStartAt;
  const spokenDuration = lastVoiceAt - speechDetectedAt;

  if (spokenDuration >= MIN_SPEECH_MS && now - lastVoiceAt >= SILENCE_MS) {
    finishCurrentSegment("检测到2.5秒停顿");
  } else if (segmentDuration >= MAX_SEGMENT_MS) {
    finishCurrentSegment("达到单题最大时长");
  }
}

function updateMeter() {
  if (!listening) return;

  const percent = Math.min(100, Math.max(1, latestRms * 700));
  $("meterFill").style.width = `${percent}%`;
  $("noiseText").textContent = noiseFloor.toFixed(4);
  $("thresholdText").textContent = voiceThreshold.toFixed(4);

  if (latestRms < voiceThreshold * 0.65) $("levelText").textContent = "环境较安静";
  else if (latestRms < voiceThreshold) $("levelText").textContent = "收到较小声音";
  else if (latestRms < 0.09) $("levelText").textContent = "正在收到清晰人声";
  else $("levelText").textContent = "声音较大";

  meterFrame = requestAnimationFrame(updateMeter);
}

async function startListening() {
  if (!workerReady) {
    setStatus("请先加载Whisper模型", "error");
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
        channelCount: 1
      }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();

    sourceNode = audioContext.createMediaStreamSource(stream);
    highPassNode = audioContext.createBiquadFilter();
    highPassNode.type = "highpass";
    highPassNode.frequency.value = 80;
    highPassNode.Q.value = 0.7;

    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    processorNode.onaudioprocess = event => {
      if (!listening) return;
      try {
        handleAudioChunk(event.inputBuffer.getChannelData(0));
        event.outputBuffer.getChannelData(0).fill(0);
      } catch (error) {
        console.error(error);
        setDiagnostic(`音频处理失败：${error?.message || String(error)}`);
      }
    };

    sourceNode.connect(highPassNode);
    highPassNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    listening = true;
    latestRms = 0;
    noiseFloor = 0.006;
    voiceThreshold = 0.014;
    segmentActive = false;
    segmentChunks = [];
    preRollChunks = [];

    $("start").disabled = true;
    $("stop").disabled = false;
    $("forceResult").disabled = false;
    $("levelText").textContent = "麦克风已打开";
    setDiagnostic(`麦克风已打开，实际采样率${audioContext.sampleRate}Hz，内部转写统一重采样到16kHz。`);
    setStatus(`${APP_VERSION} 正在持续监听`, "on");

    await requestWakeLock();
    updateMeter();
  } catch (error) {
    console.error(error);
    setDiagnostic(`麦克风启动失败：${error?.message || String(error)}`);
    setStatus("麦克风启动失败", "error");
    await stopListening();
  }
}

async function stopListening() {
  if (segmentActive && segmentChunks.length) finishCurrentSegment("停止监听前结算");

  listening = false;
  if (meterFrame) cancelAnimationFrame(meterFrame);
  meterFrame = null;

  if (processorNode) {
    processorNode.onaudioprocess = null;
    try { processorNode.disconnect(); } catch {}
  }
  try { highPassNode?.disconnect(); } catch {}
  try { sourceNode?.disconnect(); } catch {}
  try { silentGain?.disconnect(); } catch {}
  stream?.getTracks().forEach(track => track.stop());

  try { await audioContext?.close(); } catch {}
  try { await wakeLock?.release(); } catch {}

  stream = null;
  audioContext = null;
  sourceNode = null;
  highPassNode = null;
  processorNode = null;
  silentGain = null;
  wakeLock = null;

  segmentActive = false;
  segmentChunks = [];
  preRollChunks = [];
  latestRms = 0;

  $("meterFill").style.width = "0";
  $("levelText").textContent = "麦克风已关闭";
  $("start").disabled = !workerReady;
  $("stop").disabled = true;
  $("forceResult").disabled = true;
  setStatus("监听已停止，Whisper模型仍可继续使用");
  setDiagnostic("监听已停止。");
}

function forceCurrentQuestion() {
  if (!listening) return;
  if (!segmentActive || !segmentChunks.length) {
    setDiagnostic("当前还没有检测到可结算的语音。");
    return;
  }
  finishCurrentSegment("手动结束本题");
}

function rematchCurrentText() {
  const text = collapseSpaces($("question").value);
  if (text) renderTranscript(text, { elapsedMs: 0 });
}

$("loadModel").addEventListener("click", loadWhisper);
$("start").addEventListener("click", startListening);
$("stop").addEventListener("click", stopListening);
$("forceResult").addEventListener("click", forceCurrentQuestion);
$("manualAnswer").addEventListener("click", rematchCurrentText);
$("manualInput").addEventListener("click", () => {
  const value = prompt("请输入老师的问题：", $("question").value);
  if (value !== null) renderTranscript(value, { elapsedMs: 0 });
});
$("clear").addEventListener("click", () => {
  $("rawText").textContent = "—";
  $("question").value = "";
  $("termInfo").textContent = "等待识别专业术语";
  $("matched").textContent = "等待完整问题";
  $("keywords").textContent = "关键词提示会显示在这里";
  $("answer").textContent = "老师说完并停顿后，Whisper完成转写，程序会自动匹配并显示回答。";
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
  if (document.visibilityState === "visible" && listening && !wakeLock) {
    await requestWakeLock();
  }
});

if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
  $("start").disabled = true;
  setStatus("当前浏览器不支持麦克风或Web Audio", "error");
}

updateQueueText();
setStatus(`${APP_VERSION} 已加载，请选择并加载Whisper模型`, "on");
