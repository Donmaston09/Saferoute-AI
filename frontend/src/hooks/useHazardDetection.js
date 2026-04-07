import { useCallback, useEffect, useRef, useState } from "react";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import * as tf from "@tensorflow/tfjs";

const FRAME_WIDTH_THRESHOLD = 0.38;
const PROCESS_INTERVAL_MS = 150;
const MIN_CONFIDENCE = 0.55;
const MIN_BOX_AREA_RATIO = 0.015;

const THREAT_MAP = {
  person: "WATCH",
  car: "YELLOW",
  truck: "YELLOW",
  bus: "YELLOW",
  motorcycle: "YELLOW",
  bicycle: "YELLOW",
  "traffic light": "YELLOW",
  "stop sign": "YELLOW",
};

function applyHistogramEqualization(imageData) {
  const data = imageData.data;
  const len = data.length;
  const histogram = new Array(256).fill(0);

  for (let index = 0; index < len; index += 4) {
    const luminance = Math.round(0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]);
    histogram[luminance] += 1;
  }

  const pixels = len / 4;
  const cdf = new Array(256).fill(0);
  cdf[0] = histogram[0];
  for (let index = 1; index < 256; index += 1) {
    cdf[index] = cdf[index - 1] + histogram[index];
  }

  const cdfMin = cdf.find(value => value > 0) || 1;
  const lut = cdf.map(value => Math.round(((value - cdfMin) / (pixels - cdfMin)) * 255));

  for (let index = 0; index < len; index += 4) {
    data[index] = lut[data[index]];
    data[index + 1] = lut[data[index + 1]];
    data[index + 2] = lut[data[index + 2]];
  }

  return imageData;
}

function classifyDetections(predictions, frameWidth, frameHeight) {
  const detections = [];
  let highestLevel = "GREEN";
  let personCount = 0;
  const levels = { GREEN: 0, YELLOW: 1, RED: 2 };

  for (const prediction of predictions) {
    if (prediction.class === "person" && prediction.score >= MIN_CONFIDENCE) {
      personCount += 1;
    }
  }

  for (const prediction of predictions) {
    if (prediction.score < MIN_CONFIDENCE) continue;

    const [x, y, w, h] = prediction.bbox;
    const areaRatio = (w * h) / (frameWidth * frameHeight);
    if (areaRatio < MIN_BOX_AREA_RATIO) continue;

    const frameRatio = w / frameWidth;
    const rawThreat = THREAT_MAP[prediction.class] || "GREEN";

    let threatLevel = "GREEN";

    if (rawThreat === "WATCH") {
      if (personCount >= 3 && frameRatio > 0.18) {
        threatLevel = "RED";
      } else if (personCount >= 2 || frameRatio > 0.22) {
        threatLevel = "YELLOW";
      }
    } else {
      threatLevel = frameRatio > 0.14 ? rawThreat : "GREEN";
    }

    if (frameRatio > FRAME_WIDTH_THRESHOLD && threatLevel !== "GREEN") {
      threatLevel = "RED";
    }

    detections.push({
      label: prediction.class,
      confidence: prediction.score,
      bbox: { x, y, w, h },
      threatLevel,
      frameRatio,
      isClose: frameRatio > FRAME_WIDTH_THRESHOLD,
    });

    if (levels[threatLevel] > levels[highestLevel]) {
      highestLevel = threatLevel;
    }
  }

  return { detections, highestLevel };
}

export function useHazardDetection(videoRef, canvasRef, { nightMode, enabled }) {
  const [threatLevel, setThreatLevel] = useState("GREEN");
  const [detections, setDetections] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [model, setModel] = useState(null);

  const intervalRef = useRef(null);
  const offscreenRef = useRef(null);
  const stabilityRef = useRef({ candidate: "GREEN", streak: 0, stable: "GREEN" });

  useEffect(() => {
    let cancelled = false;

    async function loadModel() {
      console.log("[SafeRoute] Loading TF.js COCO-SSD model (offline-first)...");
      await tf.ready();
      const loadedModel = await cocoSsd.load({ base: "lite_mobilenet_v2" });

      if (!cancelled) {
        setModel(loadedModel);
        console.log("[SafeRoute] Model loaded");
      }
    }

    loadModel().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  const processFrame = useCallback(async () => {
    if (!model || !videoRef.current || !canvasRef.current || isProcessing) return;

    const video = videoRef.current;
    if (video.readyState < 2) return;

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;

    setIsProcessing(true);

    try {
      if (!offscreenRef.current) {
        offscreenRef.current = document.createElement("canvas");
      }

      const offscreen = offscreenRef.current;
      offscreen.width = width;
      offscreen.height = height;

      const context = offscreen.getContext("2d");
      if (!context) return;

      context.drawImage(video, 0, 0, width, height);

      if (nightMode) {
        const imageData = context.getImageData(0, 0, width, height);
        context.putImageData(applyHistogramEqualization(imageData), 0, 0);
      }

      let predictions = [];
      try {
        predictions = await model.detect(offscreen, 10, MIN_CONFIDENCE);
      } catch (error) {
        console.warn("[SafeRoute] Inference error:", error);
      }

      const { detections: nextDetections, highestLevel } = classifyDetections(predictions, width, height);
      const threshold = highestLevel === "RED" ? 3 : highestLevel === "YELLOW" ? 2 : 1;

      if (highestLevel === stabilityRef.current.candidate) {
        stabilityRef.current.streak += 1;
      } else {
        stabilityRef.current = {
          ...stabilityRef.current,
          candidate: highestLevel,
          streak: 1,
        };
      }

      const stableThreatLevel = stabilityRef.current.streak >= threshold
        ? highestLevel
        : stabilityRef.current.stable;

      stabilityRef.current.stable = stableThreatLevel;
      setDetections(nextDetections);
      setThreatLevel(stableThreatLevel);
    } finally {
      setIsProcessing(false);
    }
  }, [canvasRef, isProcessing, model, nightMode, videoRef]);

  useEffect(() => {
    if (!enabled || !model) {
      clearInterval(intervalRef.current);
      return undefined;
    }

    intervalRef.current = setInterval(processFrame, PROCESS_INTERVAL_MS);
    return () => clearInterval(intervalRef.current);
  }, [enabled, model, processFrame]);

  return { threatLevel, detections, isProcessing, modelLoaded: Boolean(model) };
}
