import { useCallback, useEffect, useRef, useState } from "react";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import * as tf from "@tensorflow/tfjs";

const FRAME_WIDTH_THRESHOLD = 0.38;
const PROCESS_INTERVAL_MS = 150;
const MIN_CONFIDENCE = 0.65;
const MIN_BOX_AREA_RATIO = 0.025;
const TRACK_EXPIRY_MS = 2500;
const ROUTE_WINDOW = {
  left: 0.2,
  right: 0.8,
  top: 0.18,
  bottom: 0.98,
};

const THREAT_MAP = {
  person: "WATCH",
  car: "WATCH",
  truck: "WATCH",
  bus: "WATCH",
  motorcycle: "WATCH",
  bicycle: "WATCH",
  "traffic light": "GREEN",
  "stop sign": "GREEN",
};

const CLASS_ROUTE_THRESHOLDS = {
  person: 0.76,
  car: 0.8,
  truck: 0.82,
  bus: 0.84,
  motorcycle: 0.78,
  bicycle: 0.8,
  "traffic light": 1,
  "stop sign": 1,
};

const MIN_PERSISTENCE = {
  person: 3,
  car: 4,
  truck: 4,
  bus: 4,
  motorcycle: 4,
  bicycle: 4,
};

const ALERT_PROFILES = {
  conservative: {
    confidenceBoost: 0.08,
    routeBoost: 0.08,
    persistenceBoost: 2,
    redBoost: 0.08,
  },
  balanced: {
    confidenceBoost: 0,
    routeBoost: 0,
    persistenceBoost: 0,
    redBoost: 0,
  },
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function cleanupTrackHistory(trackHistory, now) {
  for (const [key, entry] of trackHistory.entries()) {
    if (now - entry.lastSeen > TRACK_EXPIRY_MS) {
      trackHistory.delete(key);
    }
  }
}

function buildTrackKey(prediction, frameWidth, frameHeight) {
  const [x, y, w, h] = prediction.bbox;
  const centerX = clamp((x + w / 2) / frameWidth, 0, 1);
  const centerY = clamp((y + h / 2) / frameHeight, 0, 1);
  const bucketX = Math.round(centerX * 8);
  const bucketY = Math.round(centerY * 6);
  return `${prediction.class}:${bucketX}:${bucketY}`;
}

function getCommunityBonus(level) {
  if (level === "RED") return 0.08;
  if (level === "YELLOW") return 0.04;
  return 0;
}

function computeRouteScore(prediction, frameWidth, frameHeight, persistence, communityRiskLevel) {
  const [x, y, w, h] = prediction.bbox;
  const centerX = clamp((x + w / 2) / frameWidth, 0, 1);
  const bottomY = clamp((y + h) / frameHeight, 0, 1);
  const areaRatio = (w * h) / (frameWidth * frameHeight);
  const centerBias = 1 - clamp(Math.abs(centerX - 0.5) / 0.5, 0, 1);
  const forwardBias = clamp((bottomY - 0.2) / 0.8, 0, 1);
  const sizeBias = clamp(areaRatio / 0.12, 0, 1);
  const inRouteWindow = centerX >= ROUTE_WINDOW.left &&
    centerX <= ROUTE_WINDOW.right &&
    bottomY >= ROUTE_WINDOW.top &&
    bottomY <= ROUTE_WINDOW.bottom;

  const routeScore =
    prediction.score * 0.42 +
    centerBias * 0.18 +
    forwardBias * 0.18 +
    sizeBias * 0.12 +
    clamp(persistence / 4, 0, 1) * 0.1 +
    (inRouteWindow ? 0.06 : 0) +
    getCommunityBonus(communityRiskLevel);

  return {
    routeScore,
    centerBias,
    forwardBias,
    inRouteWindow,
  };
}

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

function classifyDetections(predictions, frameWidth, frameHeight, { communityRiskLevel, trackHistory, alertProfile }) {
  const detections = [];
  let highestLevel = "GREEN";
  let personCount = 0;
  const levels = { GREEN: 0, YELLOW: 1, RED: 2 };
  const profile = ALERT_PROFILES[alertProfile] || ALERT_PROFILES.conservative;
  let reviewConfidence = 0;

  for (const prediction of predictions) {
    if (prediction.class === "person" && prediction.score >= MIN_CONFIDENCE + profile.confidenceBoost) {
      personCount += 1;
    }
  }

  for (const prediction of predictions) {
    if (prediction.score < MIN_CONFIDENCE + profile.confidenceBoost) continue;

    const [x, y, w, h] = prediction.bbox;
    const areaRatio = (w * h) / (frameWidth * frameHeight);
    if (areaRatio < MIN_BOX_AREA_RATIO) continue;

    const frameRatio = w / frameWidth;
    const rawThreat = THREAT_MAP[prediction.class] || "GREEN";
    const trackKey = buildTrackKey(prediction, frameWidth, frameHeight);
    const persistence = trackHistory.get(trackKey)?.count || 1;
    const routeContext = computeRouteScore(
      prediction,
      frameWidth,
      frameHeight,
      persistence,
      communityRiskLevel
    );
    const routeThreshold = CLASS_ROUTE_THRESHOLDS[prediction.class] || 0.7;
    const minPersistence = MIN_PERSISTENCE[prediction.class] || 3;

    if (
      routeContext.routeScore < routeThreshold + profile.routeBoost ||
      persistence < minPersistence + profile.persistenceBoost
    ) continue;

    let threatLevel = "GREEN";

    if (rawThreat === "WATCH") {
      if (prediction.class === "person") {
        if (
          personCount >= 3 &&
          frameRatio > 0.24 &&
          routeContext.routeScore >= 0.88 + profile.redBoost &&
          persistence >= 5 + profile.persistenceBoost
        ) {
          threatLevel = "RED";
        } else if (
          (
            (personCount >= 2 && routeContext.inRouteWindow) ||
            frameRatio > 0.3 ||
            communityRiskLevel === "RED"
          ) &&
          routeContext.routeScore >= 0.8 + profile.routeBoost &&
          persistence >= 4 + profile.persistenceBoost
        ) {
          threatLevel = "YELLOW";
        }
      } else if (
        routeContext.inRouteWindow &&
        frameRatio > 0.24 &&
        routeContext.routeScore >= 0.82 + profile.routeBoost &&
        persistence >= 5 + profile.persistenceBoost
      ) {
        threatLevel = "YELLOW";
      }
    }

    if (
      frameRatio > FRAME_WIDTH_THRESHOLD &&
      threatLevel === "YELLOW" &&
      routeContext.routeScore >= 0.9 + profile.redBoost &&
      persistence >= 5 + profile.persistenceBoost &&
      routeContext.inRouteWindow &&
      (communityRiskLevel !== "GREEN" || prediction.class === "person")
    ) {
      threatLevel = "RED";
    }

    const confidenceScore = Math.min(
      0.98,
      prediction.score * 0.45 +
      routeContext.routeScore * 0.3 +
      Math.min(persistence / 6, 1) * 0.15 +
      (routeContext.inRouteWindow ? 0.05 : 0) +
      (communityRiskLevel === "RED" ? 0.05 : communityRiskLevel === "YELLOW" ? 0.02 : 0)
    );

    detections.push({
      label: prediction.class,
      confidence: prediction.score,
      bbox: { x, y, w, h },
      threatLevel,
      frameRatio,
      isClose: frameRatio > FRAME_WIDTH_THRESHOLD,
      routeScore: routeContext.routeScore,
      inRouteWindow: routeContext.inRouteWindow,
      persistence,
      confidenceScore,
    });

    reviewConfidence = Math.max(reviewConfidence, confidenceScore);

    if (levels[threatLevel] > levels[highestLevel]) {
      highestLevel = threatLevel;
    }
  }

  return { detections, highestLevel, reviewConfidence };
}

export function useHazardDetection(videoRef, canvasRef, { nightMode, enabled, context = {} }) {
  const [threatLevel, setThreatLevel] = useState("GREEN");
  const [detections, setDetections] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [model, setModel] = useState(null);
  const [reviewState, setReviewState] = useState({ needsConfirmation: false, confidence: 0 });

  const intervalRef = useRef(null);
  const offscreenRef = useRef(null);
  const stabilityRef = useRef({ candidate: "GREEN", streak: 0, stable: "GREEN" });
  const trackHistoryRef = useRef(new Map());

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

      const now = Date.now();
      cleanupTrackHistory(trackHistoryRef.current, now);

      for (const prediction of predictions) {
        if (prediction.score < MIN_CONFIDENCE) continue;

        const key = buildTrackKey(prediction, width, height);
        const existing = trackHistoryRef.current.get(key);
        trackHistoryRef.current.set(key, {
          count: existing ? Math.min(existing.count + 1, 6) : 1,
          lastSeen: now,
        });
      }

      const { detections: nextDetections, highestLevel, reviewConfidence } = classifyDetections(predictions, width, height, {
        communityRiskLevel: context.communityRiskLevel || "GREEN",
        trackHistory: trackHistoryRef.current,
        alertProfile: context.alertProfile || "conservative",
      });
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
      setReviewState({
        needsConfirmation: stableThreatLevel === "RED" && reviewConfidence >= 0.82 && nextDetections.length > 0,
        confidence: reviewConfidence,
      });
    } finally {
      setIsProcessing(false);
    }
  }, [canvasRef, context.alertProfile, context.communityRiskLevel, isProcessing, model, nightMode, videoRef]);

  useEffect(() => {
    if (!enabled || !model) {
      clearInterval(intervalRef.current);
      return undefined;
    }

    intervalRef.current = setInterval(processFrame, PROCESS_INTERVAL_MS);
    return () => clearInterval(intervalRef.current);
  }, [enabled, model, processFrame]);

  return { threatLevel, detections, isProcessing, modelLoaded: Boolean(model), reviewState };
}
