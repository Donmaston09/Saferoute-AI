"""
SafeRoute AI — Hazard Detection Engine
Uses YOLOv8 + OpenCV for real-time road hazard detection.
Includes histogram equalization for low-light conditions.

Install:
    pip install ultralytics opencv-python numpy

Run:
    python hazard_detector.py --source 0           # webcam
    python hazard_detector.py --source video.mp4   # video file
    python hazard_detector.py --source rtsp://...  # IP camera
"""

import cv2
import numpy as np
import argparse
import time
import json
import requests
from dataclasses import dataclass, asdict
from typing import Optional
from ultralytics import YOLO


# ─── Configuration ──────────────────────────────────────────────────────────────

FRAME_WIDTH_THRESHOLD = 0.30   # >30% of frame width → IMMEDIATE ALARM
BACKEND_URL = "http://localhost:3001/api/danger-zones"
REPORT_INTERVAL_SEC = 30       # Minimum seconds between backend reports

# YOLO classes mapped to threat levels
# 0=person, 1=bicycle, 2=car, 5=bus, 7=truck, 16=dog, 67=phone, 73=book...
THREAT_CONFIG = {
    "roadblock": {
        "classes": [2, 5, 7, 9],          # car, bus, truck, traffic light
        "color_hex": "#F59E0B",            # Yellow
        "level": "YELLOW",
        "label": "Roadblock / Checkpoint",
    },
    "pothole": {
        "classes": [],                     # Custom-trained class (index 80+ in custom model)
        "color_hex": "#F59E0B",
        "level": "YELLOW",
        "label": "Pothole",
    },
    "suspicious_group": {
        "classes": [0],                    # person
        "color_hex": "#EF4444",
        "level": "RED",
        "label": "Suspicious Group",
    },
}

# BGR colors for OpenCV overlays
COLOR_GREEN  = (34, 197, 94)
COLOR_YELLOW = (59, 130, 246)    # OpenCV is BGR
COLOR_RED    = (60, 60, 239)
COLOR_WHITE  = (255, 255, 255)
COLOR_BLACK  = (0, 0, 0)
COLOR_DARK   = (15, 23, 42)


# ─── Data Structures ────────────────────────────────────────────────────────────

@dataclass
class Detection:
    label: str
    confidence: float
    bbox: tuple          # (x1, y1, x2, y2)
    threat_level: str    # GREEN / YELLOW / RED
    frame_ratio: float   # bbox_width / frame_width


@dataclass
class FrameAnalysis:
    timestamp: float
    threat_level: str        # Highest threat in frame
    detections: list
    gps_lat: Optional[float] = None
    gps_lon: Optional[float] = None


# ─── Core Processor ─────────────────────────────────────────────────────────────

class HazardDetector:
    def __init__(self, model_path: str = "yolov8n.pt", low_light: bool = False):
        print(f"[SafeRoute AI] Loading model: {model_path}")
        self.model = YOLO(model_path)
        self.low_light = low_light
        self.last_report_time = 0
        self.frame_count = 0
        self.fps = 0
        self._fps_start = time.time()

        # Person clustering state (for suspicious group detection)
        self._person_boxes = []

    def _equalize_histogram(self, frame: np.ndarray) -> np.ndarray:
        """
        CLAHE (Contrast Limited Adaptive Histogram Equalization)
        Brightens dark frames for better night-time / dusk detection.
        Applied per channel in YCrCb color space to avoid color distortion.
        """
        ycrcb = cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb)
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        ycrcb[:, :, 0] = clahe.apply(ycrcb[:, :, 0])
        return cv2.cvtColor(ycrcb, cv2.COLOR_YCrCb2BGR)

    def _classify_threat(
        self, class_id: int, bbox: tuple, frame_w: int, frame_h: int, person_count: int
    ) -> Detection:
        """Map YOLO class → threat level. Distance estimated from bbox width ratio."""
        x1, y1, x2, y2 = bbox
        box_w = x2 - x1
        frame_ratio = box_w / frame_w

        # Person cluster logic → suspicious group
        if class_id == 0 and person_count >= 3:
            level = "RED"
            label = "Suspicious Group"
        elif class_id in THREAT_CONFIG["roadblock"]["classes"]:
            # Large vehicle blocking road
            level = "RED" if frame_ratio > FRAME_WIDTH_THRESHOLD else "YELLOW"
            label = "Roadblock" if frame_ratio > FRAME_WIDTH_THRESHOLD else "Vehicle Ahead"
        elif class_id == 0:
            level = "YELLOW"
            label = "Person on Road"
        else:
            level = "GREEN"
            label = self.model.names.get(class_id, f"Object {class_id}")

        return Detection(
            label=label,
            confidence=0.0,  # filled by caller
            bbox=bbox,
            threat_level=level,
            frame_ratio=frame_ratio,
        )

    def _draw_hud_overlay(
        self,
        frame: np.ndarray,
        analysis: FrameAnalysis,
        fps: float,
    ) -> np.ndarray:
        """Draw the HUD (Heads-Up Display) over the frame."""
        h, w = frame.shape[:2]
        overlay = frame.copy()

        # ── Status bar (top) ──────────────────────────────────────────────────
        bar_color = {
            "GREEN":  (22, 101, 52),
            "YELLOW": (92, 92, 0),
            "RED":    (127, 0, 0),
        }.get(analysis.threat_level, (22, 101, 52))
        cv2.rectangle(overlay, (0, 0), (w, 56), bar_color, -1)

        status_text = {
            "GREEN":  "  CLEAR ROAD",
            "YELLOW": "  CAUTION",
            "RED":    "  DANGER — TURN BACK",
        }.get(analysis.threat_level, "SCANNING")

        icon_color = {
            "GREEN":  COLOR_GREEN,
            "YELLOW": (0, 200, 220),
            "RED":    (60, 100, 255),
        }.get(analysis.threat_level, COLOR_GREEN)

        cv2.putText(overlay, "SafeRoute AI", (10, 22),
                    cv2.FONT_HERSHEY_DUPLEX, 0.55, COLOR_WHITE, 1, cv2.LINE_AA)
        cv2.putText(overlay, status_text, (10, 46),
                    cv2.FONT_HERSHEY_DUPLEX, 0.8, icon_color, 2, cv2.LINE_AA)
        cv2.putText(overlay, f"FPS: {fps:.1f}", (w - 90, 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, COLOR_WHITE, 1, cv2.LINE_AA)

        # ── Bounding boxes ────────────────────────────────────────────────────
        for det in analysis.detections:
            x1, y1, x2, y2 = det.bbox
            bbox_color = {
                "GREEN":  COLOR_GREEN,
                "YELLOW": COLOR_YELLOW,
                "RED":    COLOR_RED,
            }.get(det.threat_level, COLOR_GREEN)

            # Box + pulsing corners for RED threats
            cv2.rectangle(overlay, (x1, y1), (x2, y2), bbox_color, 2)
            if det.threat_level == "RED":
                corner_len = 18
                thick = 3
                pts = [(x1, y1), (x2, y1), (x1, y2), (x2, y2)]
                dirs = [(1,1), (-1,1), (1,-1), (-1,-1)]
                for (cx, cy), (dx, dy) in zip(pts, dirs):
                    cv2.line(overlay, (cx, cy), (cx + dx*corner_len, cy), COLOR_RED, thick)
                    cv2.line(overlay, (cx, cy), (cx, cy + dy*corner_len), COLOR_RED, thick)

            # Label background + text
            label_str = f"{det.label} {det.confidence:.0%}"
            (lw, lh), _ = cv2.getTextSize(label_str, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 1)
            cv2.rectangle(overlay, (x1, y1 - lh - 8), (x1 + lw + 6, y1), bbox_color, -1)
            cv2.putText(overlay, label_str, (x1 + 3, y1 - 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, COLOR_WHITE, 1, cv2.LINE_AA)

            # Distance warning bar
            if det.frame_ratio > 0.15:
                bar_w = int(det.frame_ratio * w)
                cv2.rectangle(overlay, (0, h - 12), (bar_w, h), bbox_color, -1)
                warn = "CLOSE" if det.frame_ratio > FRAME_WIDTH_THRESHOLD else f"{det.frame_ratio:.0%}"
                cv2.putText(overlay, f"Width {warn}", (6, h - 2),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.38, COLOR_WHITE, 1)

        # ── Low-light indicator ───────────────────────────────────────────────
        if self.low_light:
            cv2.putText(overlay, "LOW-LIGHT ON", (w - 140, 46),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.42, (200, 160, 0), 1)

        # Blend overlay with original for transparency
        return cv2.addWeighted(overlay, 0.88, frame, 0.12, 0)

    def _report_to_backend(self, analysis: FrameAnalysis):
        """Silently send danger zone data to Node.js backend."""
        if time.time() - self.last_report_time < REPORT_INTERVAL_SEC:
            return
        if analysis.threat_level not in ("YELLOW", "RED"):
            return
        payload = {
            "threatLevel": analysis.threat_level,
            "detections": [
                {"label": d.label, "confidence": d.confidence}
                for d in analysis.detections
            ],
            "lat": analysis.gps_lat or 0,
            "lon": analysis.gps_lon or 0,
            "timestamp": analysis.timestamp,
        }
        try:
            requests.post(BACKEND_URL, json=payload, timeout=2)
            self.last_report_time = time.time()
            print(f"[SafeRoute AI] Reported {analysis.threat_level} zone to backend")
        except Exception:
            pass  # Offline-first: silently fail

    def process_frame(self, frame: np.ndarray) -> tuple[np.ndarray, FrameAnalysis]:
        """Full pipeline: equalize → detect → classify → draw HUD."""
        h, w = frame.shape[:2]

        # 1. Low-light enhancement
        processed = self._equalize_histogram(frame) if self.low_light else frame

        # 2. YOLO inference
        results = self.model.predict(processed, verbose=False, conf=0.40)

        # 3. Parse detections
        detections = []
        person_count = 0

        if results and len(results) > 0:
            for box in results[0].boxes:
                cid = int(box.cls[0])
                conf = float(box.conf[0])
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                if cid == 0:
                    person_count += 1

        for box in (results[0].boxes if results else []):
            cid = int(box.cls[0])
            conf = float(box.conf[0])
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            det = self._classify_threat(cid, (x1, y1, x2, y2), w, h, person_count)
            det.confidence = conf
            detections.append(det)

        # 4. Aggregate threat level
        levels = {"GREEN": 0, "YELLOW": 1, "RED": 2}
        top_level = max((d.threat_level for d in detections), key=lambda l: levels[l], default="GREEN")

        # 5. Distance trigger: >30% frame width → RED
        for det in detections:
            if det.frame_ratio > FRAME_WIDTH_THRESHOLD and det.threat_level != "GREEN":
                top_level = "RED"
                det.threat_level = "RED"
                det.label = f"{det.label} (TOO CLOSE)"

        analysis = FrameAnalysis(
            timestamp=time.time(),
            threat_level=top_level,
            detections=detections,
        )

        # 6. Backend report
        self._report_to_backend(analysis)

        # 7. FPS counter
        self.frame_count += 1
        if self.frame_count % 30 == 0:
            self.fps = 30 / (time.time() - self._fps_start)
            self._fps_start = time.time()

        # 8. Draw HUD
        output_frame = self._draw_hud_overlay(frame, analysis, self.fps)

        return output_frame, analysis

    def run(self, source: str):
        """Main loop: open video source, process frames, display + log."""
        cap = cv2.VideoCapture(int(source) if source.isdigit() else source)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open source: {source}")

        print(f"[SafeRoute AI] Running on {source}. Press Q to quit.")
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        print(f"[SafeRoute AI] Resolution: {w}x{h}")

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            output, analysis = self.process_frame(frame)
            cv2.imshow("SafeRoute AI — Hazard Detector", output)

            # Console log for RED threats
            if analysis.threat_level == "RED":
                labels = [d.label for d in analysis.detections]
                print(f"[ALARM] {time.strftime('%H:%M:%S')} RED ALERT: {labels}")

            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

        cap.release()
        cv2.destroyAllWindows()


# ─── CLI Entry Point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SafeRoute AI Hazard Detector")
    parser.add_argument("--source", default="0", help="Video source (0=webcam, path, or RTSP)")
    parser.add_argument("--model",  default="yolov8n.pt", help="YOLOv8 model path")
    parser.add_argument("--night",  action="store_true",   help="Enable low-light enhancement")
    args = parser.parse_args()

    detector = HazardDetector(model_path=args.model, low_light=args.night)
    detector.run(args.source)
