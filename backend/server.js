const crypto = require("node:crypto");
const cors = require("cors");
const express = require("express");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
app.use(express.json());

let dangerZones = [];
const MAX_ZONES = 500;
const EXPIRY_MS = 6 * 60 * 60 * 1000;

function cleanExpiredZones() {
  const cutoff = Date.now() - EXPIRY_MS;
  dangerZones = dangerZones.filter(zone => zone.timestamp > cutoff);
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

app.get("/health", (_req, res) => {
  cleanExpiredZones();
  return res.json({ status: "ok", zones: dangerZones.length, uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`[SafeRoute AI] Backend listening on port ${PORT}`);
  console.log("[SafeRoute AI] POST /api/danger-zones");
  console.log("[SafeRoute AI] GET  /api/danger-zones/nearby?lat=X&lon=Y&radius=5");
});
