
"use strict";

const $ = (id) => document.getElementById(id);
const KB = window.INTERVIEW_KB || [];
const APP_VERSION = window.APP_BUILD || "V7.0.0";
const MODEL_URL = "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-cn-0.3.tar.gz";

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
let finalParts = [];
let answerTimer = null;
let modelTimer = null;
let audioChunkCount = 0;
let recognizerOutputSeen = false;
let recognizerWatchdog = null;
let lastVoiceAt = 0;
let speechStarted = false;
let lastForcedFinalAt = 0;
let emptyResultCount = 0;

function setStatus(text, mode = "") {
  $("status").textContent = text;
  $("lamp").className = "lamp" + (mode ? " " + mode : "");
}

function setDiagnostic(text) {
  $("partial").textContent = `${APP_VERSION}｜${text}`;
}

function forceFinalResult(reason = "手动") {
  if (!listening || !recognizer) return;
  try {
    lastForcedFinalAt = Date.now();
    recognizer.retrieveFinalResult();
    setDiagnostic(`${reason}触发本题结算，正在等待Vosk输出结果……`);
    setStatus("正在结算当前问题", "busy");
  } catch (error) {
    console.error("retrieveFinalResult failed", error);
    setDiagnostic("强制结算失败：" + (error?.message || String(error)));
    setStatus("强制结算失败", "error");
  }
}

function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：()（）【】\[\]\s_-]/g, "")
    .replace(/a\s*x\s*i/gi, "axi")
    .replace(/a\s*p\s*b/gi, "apb")
    .replace(/g\s*p\s*g\s*p\s*u/gi, "gpgpu")
    .replace(/p\s*t\s*p\s*x/gi, "ptpx")
    .replace(/班克/g, "bank")
    .replace(/艾克西/g, "axi")
    .replace(/爱克斯爱/g, "axi")
    .replace(/阿帕比/g, "apb")
    .replace(/格雷码/g, "gray码")
    .replace(/五十吉赫兹/g, "50ghz")
    .replace(/五十g/g, "50ghz");
}

function scoreEntry(question, entry) {
  const q = normalize(question);
  let score = 0;
  for (const raw of entry.patterns) {
    const p = normalize(raw);
    if (!p) continue;
    if (q.includes(p)) {
      score += 35 + Math.min(30, p.length * 3);
    } else {
      const chars = [...new Set(p)];
      const overlap = chars.filter((c) => q.includes(c)).length / Math.max(1, chars.length);
      if (overlap >= 0.72) score += overlap * 14;
    }
  }
  return score;
}

function genericAnswer(question) {
  const q = normalize(question);
  if (q.includes("axi") || q.includes("apb") || q.includes("总线")) {
    return {
      name: "总线与接口类通用回答",
      keywords: "接口作用｜信号流程｜握手｜状态机｜异常处理",
      answer: "这个问题我会从接口作用、信号流程和关键控制三个层面回答。模块首先接收并锁存上游的地址、数据和命令类型，再通过握手、仲裁或跨时钟机制传递到下游，最后等待响应并返回状态。设计时我重点关注VALID/READY握手、请求不能丢失、多笔事务的对应关系、复位和异常场景。简历中没有明确给出的精确信号和状态数量，我会结合真实代码补充，不会临时虚构。"
    };
  }
  if (q.includes("存储") || q.includes("bank") || q.includes("dram") || q.includes("mc")) {
    return {
      name: "存储控制类通用回答",
      keywords: "请求解析｜地址映射｜bank状态｜读写调度｜返回管理",
      answer: "这个问题可以按照存储访问链路回答：请求进入后，控制逻辑先解析地址和访问类型，完成bank选择和地址映射，再根据bank状态安排激活、读写或等待；写操作需要组织数据和掩码，读操作需要管理返回与请求对应。设计难点通常是冲突调度、部分写、跨时钟以及不同访问类型的优先级。"
    };
  }
  return {
    name: "通用项目回答框架",
    keywords: "背景｜我的任务｜实现方法｜关键难点｜验证结果",
    answer: "这个问题在当前本地题库中没有完全匹配的固定答案。我会先说明项目背景和目标，再明确我个人负责的任务；然后介绍数据流、控制流或状态机的实现方法；接着说明关键难点以及如何定位解决；最后给出仿真、波形、综合或芯片测试结果。简历中没有明确写出的精确参数和贡献边界，我不会临时虚构。"
  };
}

function matchAndAnswer(question) {
  const text = question.trim();
  if (!text) return;

  let best = null;
  let bestScore = -1;
  for (const entry of KB) {
    const s = scoreEntry(text, entry);
    if (s > bestScore) {
      best = entry;
      bestScore = s;
    }
  }
  const result = bestScore >= 22 ? best : genericAnswer(text);
  $("matched").textContent = `本地匹配：${result.name}`;
  $("keywords").textContent = result.keywords;
  $("answer").textContent = result.answer;
  setStatus(listening ? "已生成回答，继续监听下一题" : "回答已生成", listening ? "on" : "");
}

function scheduleFinalAnswer() {
  clearTimeout(answerTimer);
  answerTimer = setTimeout(() => {
    const question = finalParts.join("，").replace(/，+/g, "，").trim();
    finalParts = [];
    if (!question) return;
    $("question").value = question;
    $("partial").textContent = "问题已结束，正在本地匹配答案……";
    matchAndAnswer(question);
  }, 1300);
}

async function loadModel() {
  if (model || loading) return;
  loading = true;
  $("loadModel").disabled = true;
  $("progressBar").className = "loading";
  setStatus("正在下载并解压离线中文模型，请保持页面打开", "busy");
  $("modelInfo").textContent = "首次加载可能需要1到5分钟，取决于网络速度。模型约50 MB，解压后会占用较多内存。";

  const started = Date.now();
  modelTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    $("modelInfo").textContent = `正在加载离线中文模型……已等待 ${seconds} 秒。不要锁屏或切换应用。`;
  }, 1000);

  try {
    if (!window.Vosk || typeof window.Vosk.createModel !== "function") {
      throw new Error("Vosk程序未加载。请检查网络后刷新页面。");
    }
    model = await window.Vosk.createModel(MODEL_URL);
    clearInterval(modelTimer);
    $("progressBar").className = "";
    $("progressBar").style.width = "100%";
    $("modelInfo").textContent = "离线中文模型加载完成。现在可以打开麦克风并持续自动识别。";
    $("start").disabled = false;
    setStatus("模型已就绪，点击“开始持续监听”", "on");
  } catch (error) {
    clearInterval(modelTimer);
    console.error(error);
    $("progressBar").className = "";
    $("progressBar").style.width = "0";
    $("loadModel").disabled = false;
    $("modelInfo").textContent = "模型加载失败：" + (error?.message || String(error)) + "。请确认网络、VPN和浏览器内存后重试。";
    setStatus("模型加载失败", "error");
  } finally {
    loading = false;
  }
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch (error) {
    console.warn("Wake lock unavailable", error);
  }
}

function buildRecognizer(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("无法取得有效的麦克风采样率：" + sampleRate);
  }

  // vosk-browser 0.0.8 requires the recognizer sample rate.
  // Omitting it creates an unusable recognizer that receives audio but emits no text.
  recognizer = new model.KaldiRecognizer(sampleRate);
  recognizerOutputSeen = false;

  recognizer.on("partialresult", (message) => {
    const partial = (message?.result?.partial || "").trim();
    if (partial) {
      recognizerOutputSeen = true;
      setDiagnostic("实时识别：" + partial);
      setStatus("正在识别老师说话", "on");
    }
  });

  recognizer.on("result", (message) => {
    const text = (message?.result?.text || "").trim();
    recognizerOutputSeen = true;
    if (text) {
      emptyResultCount = 0;
      finalParts.push(text);
      setDiagnostic("已识别片段：" + finalParts.join("，"));
      setStatus("检测到停顿，等待问题是否继续", "busy");
      scheduleFinalAnswer();
    } else {
      emptyResultCount += 1;
      setDiagnostic(`识别器返回了空结果 ${emptyResultCount} 次。请靠近麦克风，用普通话连续说3到5秒。`);
      setStatus("已收到识别器响应，但本次没有文字", "busy");
    }
  });

  recognizer.on("error", (message) => {
    const detail = message?.error || "未知识别器错误";
    console.error("Vosk recognizer error", message);
    setDiagnostic("本地识别器错误：" + detail);
    setStatus("本地识别器启动失败", "error");
  });
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
  const percent = Math.min(100, Math.max(1, rms * 650));
  $("meterFill").style.width = percent + "%";

  const now = Date.now();
  if (rms < 0.012) {
    $("levelText").textContent = "环境较安静";
    if (speechStarted && now - lastVoiceAt > 1400 && now - lastForcedFinalAt > 2500) {
      speechStarted = false;
      forceFinalResult("检测到停顿后自动");
    }
  } else {
    lastVoiceAt = now;
    speechStarted = true;
    if (rms < 0.035) $("levelText").textContent = "收到较小声音";
    else if (rms < 0.09) $("levelText").textContent = "正在收到清晰人声";
    else $("levelText").textContent = "声音较大";
  }

  meterFrame = requestAnimationFrame(updateMeter);
}

async function startListening() {
  if (!model) {
    setStatus("请先加载离线中文模型", "error");
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
    buildRecognizer(audioContext.sampleRate);

    sourceNode = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.18;

    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    audioChunkCount = 0;
    lastVoiceAt = 0;
    speechStarted = false;
    lastForcedFinalAt = 0;
    emptyResultCount = 0;
    processorNode.onaudioprocess = (event) => {
      if (!listening || !recognizer) return;
      try {
        audioChunkCount += 1;
        recognizer.acceptWaveform(event.inputBuffer);
        event.outputBuffer.getChannelData(0).fill(0);
      } catch (error) {
        console.error("acceptWaveform failed", error);
        $("partial").textContent = "音频送入识别器失败：" + (error?.message || String(error));
        setStatus("识别器处理音频失败", "error");
      }
    };

    sourceNode.connect(analyser);
    sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    listening = true;
    $("start").disabled = true;
    $("stop").disabled = false;
    $("forceResult").disabled = false;
    setDiagnostic(`识别器已创建，实际采样率 ${audioContext.sampleRate} Hz。请说一句完整普通话。`);
    $("levelText").textContent = "麦克风已打开";
    setStatus(`${APP_VERSION} 正在持续监听（${audioContext.sampleRate} Hz）`, "on");

    clearInterval(recognizerWatchdog);
    recognizerWatchdog = setInterval(() => {
      if (!listening || recognizerOutputSeen) return;
      if (audioChunkCount > 0) {
        setDiagnostic(`音频已送入识别器：${audioChunkCount}块，${audioContext.sampleRate} Hz；尚无文字。请连续说3到5秒，再安静2秒。`);
      }
    }, 3000);

    await requestWakeLock();
    updateMeter();
  } catch (error) {
    console.error(error);
    setStatus("麦克风启动失败", "error");
    $("partial").textContent = "麦克风启动失败：" + (error?.message || String(error)) + "。请在网站权限中允许麦克风。";
    await stopListening();
  }
}

async function stopListening() {
  listening = false;
  clearTimeout(answerTimer);
  clearInterval(recognizerWatchdog);
  recognizerWatchdog = null;
  audioChunkCount = 0;
  recognizerOutputSeen = false;
  lastVoiceAt = 0;
  speechStarted = false;
  lastForcedFinalAt = 0;
  emptyResultCount = 0;
  finalParts = [];

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

  if (recognizer) {
    try { recognizer.remove(); } catch {}
  }
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

  $("meterFill").style.width = "0";
  $("levelText").textContent = "麦克风已关闭";
  $("start").disabled = !model;
  $("stop").disabled = true;
  $("forceResult").disabled = true;
  setDiagnostic("监听已停止。");
  setStatus(model ? "监听已停止，模型仍然可用" : "监听已停止", "");
}

$("loadModel").addEventListener("click", loadModel);
$("start").addEventListener("click", startListening);
$("stop").addEventListener("click", stopListening);
$("forceResult").addEventListener("click", () => forceFinalResult("手动"));
$("manualAnswer").addEventListener("click", () => matchAndAnswer($("question").value));
$("manualInput").addEventListener("click", () => {
  const value = prompt("请输入老师的问题：", $("question").value);
  if (value !== null) {
    $("question").value = value.trim();
    matchAndAnswer(value);
  }
});
$("clear").addEventListener("click", () => {
  finalParts = [];
  $("question").value = "";
  $("partial").textContent = listening ? "等待老师说话……" : "等待开始监听……";
  $("matched").textContent = "等待识别问题";
  $("keywords").textContent = "关键词提示会显示在这里";
  $("answer").textContent = "老师说完问题并停顿后，答案会自动显示。";
});
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("answer").textContent);
    setStatus("回答已复制", listening ? "on" : "");
  } catch {
    setStatus("复制失败，请长按回答文字复制", "error");
  }
});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && listening && !wakeLock) {
    await requestWakeLock();
  }
});

if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
  $("start").disabled = true;
  $("modelInfo").textContent = "当前浏览器缺少麦克风或Web Audio支持，请更新Edge/华为浏览器。";
  setStatus("当前浏览器不支持真实麦克风采集", "error");
}

setStatus(`${APP_VERSION} 已加载，请先加载离线中文模型`, "on");
