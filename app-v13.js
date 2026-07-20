"use strict";

const $ = id => document.getElementById(id);
const KB = window.INTERVIEW_KB || [];
const RESUME_TERMS = window.RESUME_TERMS || [];
const TERM_GRAMMAR = window.TERM_GRAMMAR || ["[unk]"];
const ALIAS_TO_TERM = window.ALIAS_TO_TERM || {};
const TOPIC_PROFILES = window.TOPIC_PROFILES || [];
const BEHAVIOR_PROFILES = window.BEHAVIOR_PROFILES || [];
const APP_VERSION = window.APP_BUILD || "V13.0.0";
const MODEL_URL = "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-cn-0.3.tar.gz";

const SILENCE_MS = 2300;
const FINAL_WAIT_MS = 800;
const MIN_SPEECH_MS = 600;
const TERM_CONFIDENCE = 0.55;

let model = null;
let mainRecognizer = null;
let termRecognizer = null;
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
let mainPartial = "";
let mainFinalParts = [];
let termPartial = "";
let termCandidates = new Map();
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

function collapse(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}

function normalize(text) {
  return collapse(text)
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：()（）【】\[\]{}"'`~_\-/\\]/g, "");
}

function bigrams(text) {
  const value = normalize(text);
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

function termFromAlias(text) {
  const key = normalize(text);
  if (!key || key === "[unk]" || key === "unk") return null;

  if (ALIAS_TO_TERM[key]) return ALIAS_TO_TERM[key];

  for (const [canonical, aliases] of RESUME_TERMS) {
    for (const alias of [canonical, ...aliases]) {
      const aliasKey = normalize(alias);
      if (aliasKey && (key.includes(aliasKey) || aliasKey.includes(key))) {
        return canonical;
      }
    }
  }
  return null;
}

function averageConfidence(message) {
  const words = message?.result?.result;
  if (!Array.isArray(words) || !words.length) return 0.62;
  const valid = words.map(item => Number(item.conf)).filter(Number.isFinite);
  if (!valid.length) return 0.62;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function recordTermResult(message, partial = false) {
  const text = collapse(partial ? message?.result?.partial : message?.result?.text);
  if (!text) return;

  const canonical = termFromAlias(text);
  if (!canonical) return;

  const confidence = partial ? 0.45 : averageConfidence(message);
  const previous = termCandidates.get(canonical) || 0;
  termCandidates.set(canonical, Math.max(previous, confidence));
  updateTermDisplay();
}

function updateTermDisplay() {
  const terms = [...termCandidates.entries()]
    .filter(([, confidence]) => confidence >= TERM_CONFIDENCE)
    .sort((a, b) => b[1] - a[1]);

  $("termInfo").textContent = terms.length
    ? terms.map(([term, confidence]) => `${term}（${Math.round(confidence * 100)}%）`).join("、")
    : (termPartial ? `术语监听中：${termPartial}` : "暂未确认简历英文术语");
}

function replaceKnownAliases(text, confirmedTerms) {
  let output = collapse(text);

  for (const [canonical, aliases] of RESUME_TERMS) {
    if (!confirmedTerms.includes(canonical)) continue;
    for (const alias of aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      output = output.replace(new RegExp(escaped.replace(/\s+/g, "\\s*"), "gi"), canonical);
    }
  }

  const directReplacements = [
    [/鸡皮鸡皮油|机皮机皮优|吉皮吉皮优|基皮基皮优/g, "GPGPU"],
    [/鸡皮油|机皮优/g, "GPU"],
    [/艾克西|爱克西|埃克西|阿克西|艾克赛/g, "AXI"],
    [/艾皮比|爱皮比|阿皮比/g, "APB"],
    [/皮提皮艾克斯|皮提皮叉/g, "PTPX"],
    [/西迪西/g, "CDC"],
    [/飞否|非否|菲佛/g, "FIFO"],
    [/班克控制器|板块控制器/g, "bank_controller"]
  ];
  for (const [pattern, replacement] of directReplacements) {
    if (confirmedTerms.includes(replacement) || pattern.test(output)) {
      output = output.replace(pattern, replacement);
    }
  }

  // A high-confidence sidecar term may have been omitted entirely by the main recognizer.
  const normalizedOutput = normalize(output);
  const missing = confirmedTerms.filter(term => !normalizedOutput.includes(normalize(term)));
  if (missing.length) {
    output += `（识别到术语：${missing.join("、")}）`;
  }

  return output;
}

function scoreExactQuestion(question, entry, confirmedTerms) {
  const q = normalize(question);
  const qBi = bigrams(q);
  const phrases = [
    entry.name,
    entry.canonical,
    entry.keywords,
    ...(entry.patterns || []),
    ...(entry.domainPhrases || [])
  ].filter(Boolean);

  let score = 0;
  for (const phrase of phrases) {
    const p = normalize(phrase);
    if (!p) continue;
    if (q.includes(p) || p.includes(q)) {
      score = Math.max(score, 72 + Math.min(24, Math.min(q.length, p.length)));
    }
    score = Math.max(score, dice(qBi, bigrams(p)) * 94);
  }

  const entryText = normalize(`${entry.name}${entry.keywords}${phrases.join("")}`);
  for (const term of confirmedTerms) {
    if (entryText.includes(normalize(term))) score += 22;
  }
  return Math.min(100, score);
}

function findExactQuestion(question, confirmedTerms) {
  let best = null;
  let bestScore = -1;
  let second = -1;

  for (const entry of KB) {
    const score = scoreExactQuestion(question, entry, confirmedTerms);
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

function scoreTopic(question, topic, confirmedTerms) {
  const q = normalize(question);
  let score = 0;
  for (const alias of topic.aliases || []) {
    const a = normalize(alias);
    if (!a) continue;
    if (q.includes(a)) score += 34 + Math.min(20, a.length * 2);
    else score = Math.max(score, dice(bigrams(q), bigrams(a)) * 54);
  }
  for (const term of confirmedTerms) {
    const t = normalize(term);
    if ((topic.aliases || []).some(alias => normalize(alias).includes(t) || t.includes(normalize(alias)))) {
      score += 42;
    }
  }
  return score;
}

function findTopic(question, confirmedTerms) {
  let best = null;
  let bestScore = -1;
  for (const topic of TOPIC_PROFILES) {
    const score = scoreTopic(question, topic, confirmedTerms);
    if (score > bestScore) {
      bestScore = score;
      best = topic;
    }
  }
  return { topic: best, score: bestScore };
}

function detectIntent(question) {
  const q = normalize(question);
  const intents = [
    ["compare", ["区别", "不同", "相比", "比较", "优缺点"]],
    ["why", ["为什么", "原因", "为什么选择", "考虑"]],
    ["challenge", ["难点", "困难", "挑战", "问题", "风险"]],
    ["verification", ["验证", "仿真", "测试", "怎么证明", "检查"]],
    ["result", ["结果", "指标", "效果", "成果", "达到", "提升"]],
    ["improvement", ["改进", "优化", "不足", "如果重来", "后续"]],
    ["role", ["你负责", "你的工作", "贡献", "具体做了", "职责"]],
    ["learning", ["学到", "收获", "反思", "成长"]],
    ["design", ["怎么设计", "如何实现", "实现方法", "架构", "流程", "状态机"]],
    ["overview", ["介绍", "是什么", "做什么", "功能", "讲一下"]]
  ];
  for (const [intent, words] of intents) {
    if (words.some(word => q.includes(normalize(word)))) return intent;
  }
  return "overview";
}

function intentLabel(intent) {
  return {
    overview: "概述/功能",
    role: "个人职责",
    design: "设计与实现",
    why: "设计原因",
    challenge: "难点与解决",
    verification: "验证方法",
    result: "结果与指标",
    improvement: "改进方向",
    compare: "比较分析",
    learning: "收获反思"
  }[intent] || "综合介绍";
}

function composeTopicAnswer(topic, intent) {
  if (!topic) return null;

  const fields = {
    overview: ["summary", "role"],
    role: ["role", "design"],
    design: ["summary", "design", "challenge"],
    why: ["summary", "why", "challenge"],
    challenge: ["challenge", "verification", "result"],
    verification: ["verification", "result"],
    result: ["result", "verification"],
    improvement: ["improvement", "challenge"],
    compare: ["summary", "why", "result"],
    learning: ["challenge", "improvement"]
  }[intent] || ["summary", "design"];

  const parts = [];
  for (const field of fields) {
    const value = topic[field];
    if (value && !parts.includes(value)) parts.push(value);
  }
  return parts.join("");
}

function findBehaviorAnswer(question) {
  const q = normalize(question);
  let best = null;
  let bestScore = 0;
  for (const profile of BEHAVIOR_PROFILES) {
    let score = 0;
    for (const keyword of profile.keywords) {
      if (q.includes(normalize(keyword))) score += 25;
    }
    if (score > bestScore) {
      bestScore = score;
      best = profile;
    }
  }
  return bestScore >= 25 ? best : null;
}

function renderAnswer(rawQuestion) {
  const raw = collapse(rawQuestion);
  if (!raw) {
    setDiagnostic("没有识别到有效问题，请靠近平板再试。");
    return;
  }

  const confirmedTerms = [...termCandidates.entries()]
    .filter(([, confidence]) => confidence >= TERM_CONFIDENCE)
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term);

  $("rawText").textContent = raw;
  const mergedQuestion = replaceKnownAliases(raw, confirmedTerms);
  $("question").value = mergedQuestion;
  updateTermDisplay();

  const exact = findExactQuestion(mergedQuestion, confirmedTerms);
  const intent = detectIntent(mergedQuestion);

  // Use a fixed prepared answer only when the exact-question match is reliable.
  if (exact.entry && exact.score >= 58 && exact.margin >= 5) {
    $("matched").textContent = `精确题库回答：${exact.entry.name}`;
    $("keywords").textContent = exact.entry.keywords;
    $("answer").textContent = exact.entry.answer;
    $("understanding").textContent =
      `识别主题：${exact.entry.name}｜提问意图：${intentLabel(intent)}｜题库匹配分数：${Math.round(exact.score)}`;
    setDiagnostic(`已经自动回答：${mergedQuestion}`);
    setStatus(listening ? "回答已生成，继续等待下一题" : "回答已生成", listening ? "on" : "");
    return;
  }

  // Unexpected technical question: identify a resume topic and compose an intent-specific answer.
  const topicResult = findTopic(mergedQuestion, confirmedTerms);
  if (topicResult.topic && topicResult.score >= 28) {
    const generated = composeTopicAnswer(topicResult.topic, intent);
    $("matched").textContent = `题库外组合回答：${topicResult.topic.name}`;
    $("keywords").textContent =
      `${topicResult.topic.name}｜${intentLabel(intent)}｜${confirmedTerms.join("、") || "中文主题识别"}`;
    $("answer").textContent = generated;
    $("understanding").textContent =
      `未强行套用固定题目；识别主题：${topicResult.topic.name}｜提问意图：${intentLabel(intent)}｜主题分数：${Math.round(topicResult.score)}`;
    setDiagnostic(`已根据简历项目组合回答：${mergedQuestion}`);
    setStatus(listening ? "组合回答已生成，继续等待下一题" : "组合回答已生成", listening ? "on" : "");
    return;
  }

  // Unexpected behavioral question.
  const behavior = findBehaviorAnswer(mergedQuestion);
  if (behavior) {
    $("matched").textContent = `题库外行为问题：${behavior.name}`;
    $("keywords").textContent = `${behavior.name}｜STAR表达`;
    $("answer").textContent = behavior.answer;
    $("understanding").textContent = `识别为行为面试问题：${behavior.name}`;
    setDiagnostic(`已生成行为问题回答：${mergedQuestion}`);
    setStatus(listening ? "回答已生成，继续等待下一题" : "回答已生成", listening ? "on" : "");
    return;
  }

  $("matched").textContent = "完全题库外问题";
  $("keywords").textContent = "背景｜任务｜方法｜难点｜结果";
  $("answer").textContent =
    "这个问题与当前简历题库没有形成可靠关联。回答时我会先复述对问题的理解，再说明相关背景和目标；接着讲我的判断或实现方法，并给出项目中的证据；最后说明结果、局限和后续改进。对于简历中没有做过的内容，我会明确说明了解程度，不会虚构经历。";
  $("understanding").textContent =
    `未找到可靠的简历主题。已保留老师原始问题，不会错误替换成其他固定题目。`;
  setDiagnostic(`这是题库外问题：${mergedQuestion}`);
  setStatus(listening ? "已给出通用回答框架，继续等待下一题" : "已生成通用框架", listening ? "on" : "");
}

function resetBuffers() {
  mainPartial = "";
  mainFinalParts = [];
  termPartial = "";
  termCandidates.clear();
  finalizing = false;
  speechStarted = false;
  speechStartAt = 0;
  lastVoiceAt = 0;
}

function updateLiveDisplay() {
  const current = collapse([...mainFinalParts, mainPartial].join(""));
  if (current) {
    $("rawText").textContent = current;
    setDiagnostic(`实时中文：${current}${termPartial ? `｜术语监听：${termPartial}` : ""}`);
    setStatus("正在识别老师的问题", "on");
  }
  updateTermDisplay();
}

function createRecognizers(sampleRate) {
  // Main path: exactly the V7-style unrestricted Chinese recognizer.
  mainRecognizer = new model.KaldiRecognizer(sampleRate);
  mainRecognizer.setWords(true);

  mainRecognizer.on("partialresult", message => {
    mainPartial = collapse(message?.result?.partial || "");
    updateLiveDisplay();
  });
  mainRecognizer.on("result", message => {
    const text = collapse(message?.result?.text || "");
    mainPartial = "";
    if (text) mainFinalParts.push(text);
    updateLiveDisplay();
  });
  mainRecognizer.on("error", message => {
    console.error("Main recognizer error", message);
    setDiagnostic("中文识别器错误：" + (message?.error || "未知错误"));
  });

  // Sidecar path: shares the SAME acoustic model and listens only for resume terms.
  if ($("termEnhance").checked) {
    try {
      termRecognizer = new model.KaldiRecognizer(sampleRate, JSON.stringify(TERM_GRAMMAR));
      termRecognizer.setWords(true);
      termRecognizer.on("partialresult", message => {
        termPartial = collapse(message?.result?.partial || "");
        recordTermResult(message, true);
        updateLiveDisplay();
      });
      termRecognizer.on("result", message => {
        termPartial = "";
        recordTermResult(message, false);
        updateLiveDisplay();
      });
      termRecognizer.on("error", message => {
        console.warn("Term recognizer error", message);
        $("termInfo").textContent = "术语监听器出错，但V7中文主识别仍可继续";
      });
      setDiagnostic(`V7自由中文识别器 + 简历术语监听器已创建，采样率${sampleRate}Hz。`);
    } catch (error) {
      console.warn("Term recognizer unavailable", error);
      termRecognizer = null;
      setDiagnostic(`V7自由中文识别器已创建；术语监听器不可用，已自动关闭。采样率${sampleRate}Hz。`);
    }
  } else {
    termRecognizer = null;
    setDiagnostic(`V7自由中文识别器已创建，采样率${sampleRate}Hz。`);
  }
}

async function loadModel() {
  if (loading || model) return;
  loading = true;
  $("loadModel").disabled = true;
  $("progressBar").className = "loading";
  const started = Date.now();

  modelTimer = setInterval(() => {
    $("modelInfo").textContent =
      `正在加载V7同款快速中文模型，已等待${Math.floor((Date.now() - started) / 1000)}秒。`;
  }, 1000);

  try {
    if (!window.Vosk?.createModel) throw new Error("Vosk程序未加载，请检查网络。");
    setStatus("正在加载快速中文模型", "busy");
    model = await window.Vosk.createModel(MODEL_URL);
    clearInterval(modelTimer);
    $("progressBar").className = "";
    $("progressBar").style.width = "100%";
    $("modelInfo").textContent =
      "模型已加载。中文主识别和简历术语监听共享同一个模型，不会再加载英文模型或Whisper。";
    $("start").disabled = false;
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
  if (!listening || finalizing || !mainRecognizer) return;
  if (!mainFinalParts.length && !mainPartial) return;

  finalizing = true;
  lastFinalizeAt = Date.now();
  const backup = collapse([...mainFinalParts, mainPartial].join(""));
  setStatus(`${reason}，正在合并中文和简历术语`, "busy");
  setDiagnostic(`${reason}，正在获取最终结果……`);

  try { mainRecognizer.retrieveFinalResult(); } catch (error) { console.warn(error); }
  try { termRecognizer?.retrieveFinalResult(); } catch (error) { console.warn(error); }

  clearTimeout(finalizeTimer);
  finalizeTimer = setTimeout(() => {
    const finalText = collapse([...mainFinalParts, mainPartial].join("")) || backup;
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
    createRecognizers(audioContext.sampleRate);

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
      if (!listening || !mainRecognizer) return;
      try {
        mainRecognizer.acceptWaveform(event.inputBuffer);
        termRecognizer?.acceptWaveform(event.inputBuffer);
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
    $("termEnhance").disabled = true;
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

  try { mainRecognizer?.remove(); } catch {}
  try { termRecognizer?.remove(); } catch {}
  try { await audioContext?.close(); } catch {}
  try { await wakeLock?.release(); } catch {}

  mainRecognizer = null;
  termRecognizer = null;
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
  $("termEnhance").disabled = false;
  setDiagnostic("监听已停止。");
  setStatus("监听已停止，模型仍可使用");
}

function rematchText() {
  const text = $("question").value || $("rawText").textContent;
  if (text && text !== "—") renderAnswer(text);
}

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
  $("understanding").textContent = "等待识别问题主题和提问意图";
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

setStatus(`${APP_VERSION} 已加载，请先加载快速中文模型`, "on");
