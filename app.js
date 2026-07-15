
const $ = (id) => document.getElementById(id);
const resume = JSON.parse($("resumeData").textContent);

let stream = null;
let audioContext = null;
let analyser = null;
let mediaRecorder = null;
let chunks = [];
let rafId = null;
let listening = false;
let recordingSpeech = false;
let speechStartAt = 0;
let lastLoudAt = 0;
let processing = false;

function setStatus(text, mode="off"){
  $("statusText").textContent = text;
  $("lamp").className = "lamp" + (mode === "on" ? " on" : mode === "busy" ? " busy" : "");
}
function apiKey(){
  return $("apiKey").value.trim();
}
function chooseMime(){
  const choices = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus"
  ];
  return choices.find(x => window.MediaRecorder && MediaRecorder.isTypeSupported(x)) || "";
}
function extensionForMime(mime){
  if(mime.includes("mp4")) return "m4a";
  if(mime.includes("ogg")) return "ogg";
  return "webm";
}

async function startListening(){
  if(!window.isSecureContext){
    alert("麦克风需要HTTPS安全页面。请通过部署后的HTTPS网址打开，不要直接从文件管理器打开HTML。");
    return;
  }
  if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder){
    alert("当前浏览器不支持所需的麦克风录音接口。请更新华为浏览器后重试。");
    return;
  }
  if(!apiKey()){
    $("settingsDialog").showModal();
    setStatus("请先填写API Key");
    return;
  }
  try{
    stream = await navigator.mediaDevices.getUserMedia({
      audio:{
        echoCancellation:true,
        noiseSuppression:true,
        autoGainControl:true,
        channelCount:1
      }
    });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.25;
    source.connect(analyser);
    listening = true;
    $("startBtn").disabled = true;
    $("stopBtn").disabled = false;
    setStatus("正在收听环境声音", "on");
    monitorLevel();
  }catch(err){
    setStatus("无法使用麦克风");
    alert("麦克风启动失败：" + err.message);
  }
}

function monitorLevel(){
  if(!listening || !analyser) return;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for(const v of data){
    const x = (v - 128) / 128;
    sum += x*x;
  }
  const rms = Math.sqrt(sum / data.length);
  $("meterFill").style.width = Math.min(100, rms * 650) + "%";

  const threshold = Number($("threshold").value);
  const now = performance.now();
  if(rms >= threshold){
    lastLoudAt = now;
    if(!recordingSpeech && !processing) beginUtterance();
  }
  if(recordingSpeech){
    const silence = Number($("silenceMs").value);
    const length = now - speechStartAt;
    if(length > 700 && now - lastLoudAt > silence) finishUtterance();
    else if(length > 25000) finishUtterance();
  }
  rafId = requestAnimationFrame(monitorLevel);
}

function beginUtterance(){
  const mime = chooseMime();
  chunks = [];
  try{
    mediaRecorder = mime ? new MediaRecorder(stream,{mimeType:mime}) : new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if(e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = processUtterance;
    mediaRecorder.start(250);
    recordingSpeech = true;
    speechStartAt = performance.now();
    lastLoudAt = speechStartAt;
    setStatus("检测到老师说话，正在录入", "on");
  }catch(err){
    setStatus("录音启动失败");
    console.error(err);
  }
}

function finishUtterance(){
  if(!recordingSpeech || !mediaRecorder) return;
  recordingSpeech = false;
  if(mediaRecorder.state !== "inactive") mediaRecorder.stop();
  setStatus("正在识别问题", "busy");
}

async function processUtterance(){
  if(chunks.length === 0){
    setStatus("正在收听环境声音", "on");
    return;
  }
  processing = true;
  try{
    const mime = mediaRecorder.mimeType || chooseMime() || "audio/webm";
    const blob = new Blob(chunks,{type:mime});
    chunks = [];
    const text = await transcribe(blob, mime);
    if(text && text.trim().length >= 2){
      $("question").value = text.trim();
      setStatus("问题已识别，正在组织回答", "busy");
      await generateAnswer();
    }else{
      setStatus("没有识别到有效问题，继续监听", "on");
    }
  }catch(err){
    console.error(err);
    setStatus("识别失败，继续监听", "on");
    $("answer").textContent = "识别或生成失败：" + err.message;
  }finally{
    processing = false;
    if(listening) setStatus("正在收听环境声音", "on");
  }
}

async function transcribe(blob, mime){
  const form = new FormData();
  form.append("file", blob, "question." + extensionForMime(mime));
  form.append("model", $("sttModel").value.trim() || "gpt-4o-mini-transcribe");
  form.append("language", "zh");
  form.append("response_format", "json");
  form.append("prompt", "这是数字芯片设计、SoC、FPGA、验证、存储控制器、AXI、APB、PTPX和超导存储相关的中文面试问题。");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions",{
    method:"POST",
    headers:{Authorization:"Bearer " + apiKey()},
    body:form
  });
  const data = await res.json();
  if(!res.ok) throw new Error(data?.error?.message || "语音识别请求失败");
  return data.text || "";
}

function systemPrompt(styleExtra=""){
  return `你是数字IC校招模拟面试回答助手。只能依据候选人的简历和通用专业知识组织回答，不得虚构候选人没有做过的工作。
输出必须使用第一人称中文，适合候选人直接口头表达。
严格使用下面格式：
关键词：用“｜”分隔的5到8个短词
回答：自然口语回答
回答默认控制在180到320字。技术问题按照“作用或背景—我的设计—关键难点—验证或结果”组织。
涉及简历中没有明确给出的精确数字、个人贡献边界或结果时，不要猜测，应提醒按真实情况补充。
避免空话、夸大和生硬背诵感。${styleExtra}`;
}

async function generateAnswer(styleExtra=""){
  const question = $("question").value.trim();
  if(!question) throw new Error("问题为空");
  if(!apiKey()){
    $("settingsDialog").showModal();
    throw new Error("请先填写API Key");
  }
  $("answer").textContent = "正在生成回答……";
  $("keywords").textContent = "正在提取关键词……";
  const payload = {
    model: $("answerModel").value.trim() || "gpt-5-mini",
    input: [
      {role:"system",content:[{type:"input_text",text:systemPrompt(styleExtra)}]},
      {role:"user",content:[{type:"input_text",text:`候选人简历：\n${resume}\n\n老师的问题：\n${question}`}]}
    ],
    max_output_tokens:700
  };
  const res = await fetch("https://api.openai.com/v1/responses",{
    method:"POST",
    headers:{
      "Authorization":"Bearer " + apiKey(),
      "Content-Type":"application/json"
    },
    body:JSON.stringify(payload)
  });
  const data = await res.json();
  if(!res.ok) throw new Error(data?.error?.message || "回答生成请求失败");
  let text = data.output_text || "";
  if(!text){
    for(const item of (data.output || [])){
      for(const c of (item.content || [])){
        if(c.type === "output_text") text += c.text || "";
      }
    }
  }
  const km = text.match(/关键词[：:]\s*([\s\S]*?)(?:\n|回答[：:])/);
  const am = text.match(/回答[：:]\s*([\s\S]*)/);
  $("keywords").textContent = km ? km[1].trim() : "项目背景｜个人任务｜设计方法｜关键难点｜验证结果";
  $("answer").textContent = am ? am[1].trim() : text.trim();
}

function stopListening(){
  listening = false;
  recordingSpeech = false;
  if(rafId) cancelAnimationFrame(rafId);
  if(mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  stream?.getTracks().forEach(t => t.stop());
  audioContext?.close();
  stream = audioContext = analyser = mediaRecorder = null;
  $("meterFill").style.width = "0";
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  setStatus("已停止监听");
}

$("startBtn").onclick = startListening;
$("stopBtn").onclick = stopListening;
$("settingsBtn").onclick = () => $("settingsDialog").showModal();
$("testBtn").onclick = () => {
  const x = prompt("请输入老师的问题：", $("question").value);
  if(x !== null) $("question").value = x;
};
$("answerBtn").onclick = async () => {
  try{ setStatus("正在组织回答","busy"); await generateAnswer(); setStatus(listening?"正在收听环境声音":"回答已生成",listening?"on":"off"); }
  catch(err){ $("answer").textContent = err.message; setStatus("生成失败"); }
};
$("shortBtn").onclick = async () => {
  try{ await generateAnswer("把回答压缩到80至140字，适合30秒内说完。"); }
  catch(err){ $("answer").textContent = err.message; }
};
$("detailBtn").onclick = async () => {
  try{ await generateAnswer("回答可以扩展到300至450字，补充模块结构、信号流、状态机、CDC、协议或验证方法等技术细节，但仍不得虚构。"); }
  catch(err){ $("answer").textContent = err.message; }
};
$("clearBtn").onclick = () => {
  $("question").value = "";
  $("keywords").textContent = "关键词提示会显示在这里";
  $("answer").textContent = "请先开始监听。";
};
$("copyBtn").onclick = async () => {
  await navigator.clipboard.writeText($("answer").textContent);
  setStatus("回答已复制");
};
$("threshold").oninput = e => $("thresholdValue").textContent = Number(e.target.value).toFixed(3);

if("serviceWorker" in navigator){
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(console.warn));
}
