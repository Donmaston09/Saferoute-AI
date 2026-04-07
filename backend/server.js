const crypto = require("node:crypto");
const cors = require("cors");
const express = require("express");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
app.use(express.json());

let dangerZones = [];
const MAX_ZONES = 500;
const EXPIRY_MS = 6 * 60 * 60 * 1000;

function cleanExpiredZones() {
  const cutoff = Date.now() - EXPIRY_MS;
  dangerZones = dangerZones.filter(zone => zone.timestamp > cutoff);
}

function normalizeDetectionLabel(label = "") {
  const value = label.toLowerCase();

  if (value.includes("pothole") || value.includes("road_damage")) return "road damage";
  if (value.includes("checkpoint")) return "checkpoint structure";
  if (value.includes("roadblock") || value.includes("barrier")) return "roadblock";
  if (value.includes("vehicle_blocking_lane")) return "vehicle blocking lane";
  if (value.includes("person_in_roadway")) return "person in roadway";
  if (value.includes("crowd_on_road")) return "crowd on road";
  if (value.includes("stop sign")) return "stop sign";
  if (value.includes("traffic light")) return "traffic light";

  return value.replaceAll("_", " ");
}

function buildHeuristicContextReport({
  detections = [],
  threatLevel = "GREEN",
  communityRiskLevel = "GREEN",
  nearbyZones = [],
}) {
  const relevantDetections = detections
    .filter(detection => detection.threatLevel && detection.threatLevel !== "GREEN")
    .sort((left, right) => (right.routeScore || 0) - (left.routeScore || 0));
  const primaryDetection = relevantDetections[0];
  const labels = [...new Set(relevantDetections.map(detection => normalizeDetectionLabel(detection.label)))];
  const corroboration = nearbyZones.filter(zone => zone.threatLevel !== "GREEN").length;

  const confidence = primaryDetection
    ? Math.min(
      0.95,
      0.35 +
      (primaryDetection.confidence || 0) * 0.3 +
      Math.min((primaryDetection.persistence || 1) / 10, 0.2) +
      Math.min((primaryDetection.routeScore || 0), 0.1)
    )
    : 0.2;

  const headline = threatLevel === "RED"
    ? "High-priority warning ahead"
    : threatLevel === "YELLOW"
      ? "Potential hazard ahead"
      : "No urgent hazard detected";

  const evidence = [];
  if (labels.length) evidence.push(`Detected ${labels.join(", ")} in the driver's path.`);
  if (primaryDetection?.persistence >= 2) evidence.push(`The object persisted for ${primaryDetection.persistence} frames.`);
  if (primaryDetection?.inRouteWindow) evidence.push("The object is centrally aligned with the route corridor.");
  if (communityRiskLevel !== "GREEN") evidence.push(`Community reports nearby increase confidence to ${communityRiskLevel}.`);
  if (corroboration > 1) evidence.push(`${corroboration} nearby community zones support the warning.`);

  const guidance = threatLevel === "RED"
    ? "Slow down, create distance, and consider an alternate route if the road remains obstructed."
    : threatLevel === "YELLOW"
      ? "Proceed carefully and keep the hazard in view before changing speed or lane."
      : "Continue normally, but keep scanning for new obstacles.";

  return {
    source: "heuristic",
    confidence,
    headline,
    summary: evidence[0] || "Detector signals are currently low-risk.",
    evidence,
    guidance,
  };
}

async function buildLlmContextReport(payload, fallbackReport) {
  if (!openai) return fallbackReport;

  const prompt = [
    "You are a driving safety assistant for Nigerian and African road contexts.",
    "Convert detector output into calm, reliable guidance.",
    "Avoid dramatic language, avoid identity-based assumptions, and do not infer criminal intent.",
    "Return strict JSON with keys: headline, summary, evidence, guidance, confidence.",
    "Confidence must be a number from 0 to 1.",
    "Evidence must be an array of short strings.",
    "",
    JSON.stringify({
      threatLevel: payload.threatLevel,
      communityRiskLevel: payload.communityRiskLevel,
      detections: payload.detections,
      nearbyZones: payload.nearbyZones?.slice(0, 3),
      position: payload.position || null,
      fallback: fallbackReport,
    }),
  ].join("\n");

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: prompt,
    });

    const text = response.output_text?.trim();
    if (!text) return fallbackReport;

    const parsed = JSON.parse(text);
    return {
      source: "llm",
      confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : fallbackReport.confidence,
      headline: parsed.headline || fallbackReport.headline,
      summary: parsed.summary || fallbackReport.summary,
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.slice(0, 4) : fallbackReport.evidence,
      guidance: parsed.guidance || fallbackReport.guidance,
    };
  } catch (error) {
    console.warn("[SafeRoute] Context report fallback:", error.message);
    return fallbackReport;
  }
}

app.post("/api/danger-zones", (req, res) => {
  const { threatLevel, detections, lat, lon, timestamp } = req.body;

  if (!threatLevel || lat === undefined || lon === undefined) {
    return res.status(400).json({ error: "Missing required fields: threatLevel, lat, lon" });
  }

  if (!["YELLOW", "RED"].includes(threatLevel)) {
    return res.status(400).json({ error: "threatLevel must be YELLOW or RED" });
  }

  const parsedLat = Number.parseFloat(lat);
  const parsedLon = Number.parseFloat(lon);
  const parsedTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();

  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon)) {
    return res.status(400).json({ error: "lat and lon must be valid numbers" });
  }

  const zone = {
    id: crypto.randomUUID(),
    threatLevel,
    detections: Array.isArray(detections) ? detections.slice(0, 10) : [],
    lat: parsedLat,
    lon: parsedLon,
    timestamp: parsedTimestamp,
    reportCount: 1,
  };

  const mergeRadiusDeg = 0.001;
  const existingZone = dangerZones.find(existing =>
    Math.abs(existing.lat - zone.lat) < mergeRadiusDeg &&
    Math.abs(existing.lon - zone.lon) < mergeRadiusDeg &&
    existing.threatLevel === zone.threatLevel
  );

  if (existingZone) {
    existingZone.reportCount += 1;
    existingZone.timestamp = zone.timestamp;
    console.log(`[SafeRoute] Updated zone ${existingZone.id} (${existingZone.reportCount} reports)`);
    return res.json({ status: "updated", zone: existingZone });
  }

  if (dangerZones.length >= MAX_ZONES) {
    dangerZones.sort((left, right) => left.timestamp - right.timestamp);
    dangerZones.shift();
  }

  dangerZones.push(zone);
  console.log(`[SafeRoute] New ${threatLevel} zone at (${parsedLat}, ${parsedLon})`);
  return res.status(201).json({ status: "created", zone });
});

app.get("/api/danger-zones/nearby", (req, res) => {
  cleanExpiredZones();

  const lat = Number.parseFloat(req.query.lat);
  const lon = Number.parseFloat(req.query.lon);
  const radius = Number.parseFloat(req.query.radius) || 5;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "lat and lon are required" });
  }

  if (!Number.isFinite(radius) || radius <= 0 || radius > 50) {
    return res.status(400).json({ error: "radius must be between 0 and 50 km" });
  }

  const radiusDeg = radius / 111;
  const nearby = dangerZones
    .filter(zone => {
      const dlat = zone.lat - lat;
      const dlon = zone.lon - lon;
      return Math.sqrt(dlat * dlat + dlon * dlon) <= radiusDeg;
    })
    .map(zone => ({
      ...zone,
      distanceKm: (
        Math.sqrt(
          Math.pow((zone.lat - lat) * 111, 2) +
          Math.pow((zone.lon - lon) * 111 * Math.cos((lat * Math.PI) / 180), 2)
        )
      ).toFixed(2),
    }))
    .sort((left, right) => Number.parseFloat(left.distanceKm) - Number.parseFloat(right.distanceKm));

  return res.json({
    count: nearby.length,
    radiusKm: radius,
    zones: nearby,
  });
});

app.get("/api/danger-zones", (_req, res) => {
  cleanExpiredZones();
  return res.json({
    count: dangerZones.length,
    zones: dangerZones,
  });
});

app.delete("/api/danger-zones/:id", (req, res) => {
  const before = dangerZones.length;
  dangerZones = dangerZones.filter(zone => zone.id !== req.params.id);

  if (dangerZones.length === before) {
    return res.status(404).json({ error: "Zone not found" });
  }

  return res.json({ status: "deleted" });
});

app.post("/api/context-report", async (req, res) => {
  const {
    detections = [],
    nearbyZones = [],
    threatLevel = "GREEN",
    communityRiskLevel = "GREEN",
    position = null,
  } = req.body || {};

  const fallbackReport = buildHeuristicContextReport({
    detections,
    nearbyZones,
    threatLevel,
    communityRiskLevel,
  });

  const report = await buildLlmContextReport({
    detections,
    nearbyZones,
    threatLevel,
    communityRiskLevel,
    position,
  }, fallbackReport);

  return res.json({
    threatLevel,
    communityRiskLevel,
    report,
  });
});

app.get("/health", (_req, res) => {
  cleanExpiredZones();
  return res.json({
    status: "ok",
    zones: dangerZones.length,
    uptime: process.uptime(),
    llmConfigured: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.listen(PORT, () => {
  console.log(`[SafeRoute AI] Backend listening on port ${PORT}`);
  console.log("[SafeRoute AI] POST /api/danger-zones");
  console.log("[SafeRoute AI] GET  /api/danger-zones/nearby?lat=X&lon=Y&radius=5");
  console.log("[SafeRoute AI] POST /api/context-report");
});
