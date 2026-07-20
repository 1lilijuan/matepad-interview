import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
try {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
} catch (error) {
  console.warn("Unable to limit ONNX WASM threads", error);
}

let transcriber = null;
let loadedModel = null;

function send(type, data = {}) {
  self.postMessage({ type, ...data });
}

async function loadModel(modelId) {
  if (transcriber && loadedModel === modelId) {
    send("ready", { modelId, cached: true });
    return;
  }

  if (transcriber?.dispose) {
    try { await transcriber.dispose(); } catch {}
  }
  transcriber = null;
  loadedModel = null;

  send("loading", { modelId });
  transcriber = await pipeline("automatic-speech-recognition", modelId, {
    dtype: "q4",
    progress_callback: (progress) => send("progress", { progress }),
  });

  loadedModel = modelId;
  send("ready", { modelId, cached: false });
}

async function transcribe(message) {
  if (!transcriber) throw new Error("Whisper模型尚未加载");

  const audio = new Float32Array(message.audio);
  const options = {
    top_k: 0,
    do_sample: false,
    task: "transcribe",
    chunk_length_s: 15,
    stride_length_s: 2,
    return_timestamps: false,
  };

  if (message.language && message.language !== "auto") {
    options.language = message.language;
  }

  const started = performance.now();
  const output = await transcriber(audio, options);
  const elapsedMs = performance.now() - started;
  const text = String(output?.text || "").trim();

  send("result", {
    id: message.id,
    text,
    elapsedMs,
    audioSeconds: message.audioSeconds,
    modelId: loadedModel,
  });
}

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  try {
    if (message.type === "load") {
      await loadModel(message.modelId);
    } else if (message.type === "transcribe") {
      await transcribe(message);
    } else if (message.type === "dispose") {
      if (transcriber?.dispose) await transcriber.dispose();
      transcriber = null;
      loadedModel = null;
      send("disposed");
    }
  } catch (error) {
    send("error", {
      id: message.id,
      stage: message.type,
      message: error?.message || String(error),
      stack: error?.stack || "",
    });
  }
});
