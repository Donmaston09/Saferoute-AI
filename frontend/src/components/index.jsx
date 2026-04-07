import { useEffect } from "react";

export function CameraFeed({ videoRef, onReady, onError }) {
  useEffect(() => {
    let stream = null;
    let cancelled = false;

    async function startCamera() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera access is not supported in this browser.");
        }

        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (!videoRef.current || cancelled) return;

        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = async () => {
          try {
            await videoRef.current?.play();
            onReady?.();
            onError?.("");
          } catch (playbackError) {
            onError?.(playbackError.message || "Unable to start the live camera preview.");
          }
        };
      } catch (error) {
        console.error("[SafeRoute] Camera error:", error);
        onError?.(error.message || "Unable to access the camera.");
      }
    }

    startCamera();

    return () => {
      cancelled = true;

      if (videoRef.current) {
        videoRef.current.onloadedmetadata = null;
        videoRef.current.srcObject = null;
      }

      stream?.getTracks().forEach(track => track.stop());
    };
  }, [onError, onReady, videoRef]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      className="camera-feed"
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
    />
  );
}

export function AlertBanner({ threatLevel, detections }) {
  if (!threatLevel || threatLevel === "GREEN") return null;

  const isRed = threatLevel === "RED";
  const labels = [...new Set(detections.map(detection => detection.label))].join(", ") || "Hazard";

  return (
    <div className={`alert-banner alert-${threatLevel.toLowerCase()}`} role="alert">
      <span className="alert-icon">{isRed ? "⚠" : "◈"}</span>
      <span className="alert-text">
        {isRed
          ? `DANGER - ${labels.toUpperCase()} DETECTED`
          : `CAUTION - ${labels.toUpperCase()}`}
      </span>
      {isRed ? <span className="alert-pulse" /> : null}
    </div>
  );
}

export function CommunityWarning({ zones }) {
  const redZones = zones.filter(zone => zone.threatLevel === "RED");
  const closestZone = zones
    .map(zone => ({
      ...zone,
      distance: Number.parseFloat(zone.distanceKm) || Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.distance - right.distance)[0];

  if (!closestZone) return null;

  return (
    <div className="community-warning">
      <span className="cw-icon">⬡</span>
      <div className="cw-text">
        <strong>COMMUNITY ALERT</strong>
        <span>
          {redZones.length} high-risk zone{redZones.length !== 1 ? "s" : ""} reported nearby.
          Closest: {closestZone.distance.toFixed(2)} km - {closestZone.detections?.[0]?.label || "Hazard"}
        </span>
      </div>
    </div>
  );
}

export function ContextReportCard({ report, isLoading }) {
  if (!isLoading && !report) return null;

  return (
    <section className="context-report-card" aria-live="polite">
      <div className="context-report-header">
        <strong>Context Report</strong>
        {report?.source ? <span>{report.source.toUpperCase()}</span> : null}
      </div>
      <p className="context-report-headline">
        {isLoading && !report ? "Analyzing route context..." : report?.headline}
      </p>
      {report?.summary ? <p className="context-report-summary">{report.summary}</p> : null}
      {report?.evidence?.length ? (
        <div className="context-report-evidence">
          {report.evidence.map(item => (
            <p key={item}>{item}</p>
          ))}
        </div>
      ) : null}
      {report?.guidance ? <p className="context-report-guidance">{report.guidance}</p> : null}
      {typeof report?.confidence === "number" ? (
        <p className="context-report-confidence">
          Reliability {(report.confidence * 100).toFixed(0)}%
        </p>
      ) : null}
    </section>
  );
}

export function SafetyActions({
  alertProfile,
  onAlertProfileChange,
  reviewState,
  onConfirmHazard,
  onDismissHazard,
}) {
  return (
    <section className="safety-actions">
      <div className="safety-actions-header">
        <strong>Alert Mode</strong>
        <div className="alert-profile-toggle">
          <button
            className={`profile-btn ${alertProfile === "conservative" ? "active" : ""}`}
            onClick={() => onAlertProfileChange("conservative")}
          >
            Conservative
          </button>
          <button
            className={`profile-btn ${alertProfile === "balanced" ? "active" : ""}`}
            onClick={() => onAlertProfileChange("balanced")}
          >
            Balanced
          </button>
        </div>
      </div>

      {reviewState?.needsConfirmation ? (
        <div className="confirmation-panel">
          <p className="confirmation-title">Confirm before sharing</p>
          <p className="confirmation-copy">
            High-risk alert confidence {(reviewState.confidence * 100).toFixed(0)}%. Confirm this hazard before it is shared with other drivers.
          </p>
          <div className="confirmation-actions">
            <button className="confirm-btn" onClick={onConfirmHazard}>Confirm Hazard</button>
            <button className="dismiss-btn" onClick={onDismissHazard}>False Alarm</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function ControlPanel({
  nightMode,
  onNightModeToggle,
  threatLevel,
  nearbyZones,
  modelReady,
}) {
  return (
    <footer className="control-panel">
      <div className="controls-row">
        <button
          className={`ctrl-btn ${nightMode ? "active" : ""}`}
          onClick={onNightModeToggle}
          aria-label="Toggle night mode"
        >
          <span className="btn-icon">◐</span>
          <span className="btn-label">NIGHT<br />MODE</span>
        </button>

        <div className={`threat-indicator threat-${(threatLevel || "GREEN").toLowerCase()}`}>
          <div className="threat-ring" />
          <span className="threat-label">{threatLevel || "CLEAR"}</span>
        </div>

        <div className={`ctrl-btn info-btn ${modelReady ? "active" : ""}`}>
          <span className="btn-icon">{modelReady ? "◉" : "◎"}</span>
          <span className="btn-label">{nearbyZones.length}<br />ZONES</span>
        </div>
      </div>

      {nearbyZones.length > 0 ? (
        <div className="zones-list">
          <p className="zones-title">Reported Ahead</p>
          {nearbyZones.slice(0, 3).map(zone => (
            <div key={zone.id} className={`zone-item zone-${zone.threatLevel.toLowerCase()}`}>
              <span className="zone-dist">{zone.distanceKm} km</span>
              <span className="zone-label">
                {zone.detections?.[0]?.label || "Hazard"} - {zone.threatLevel}
                {zone.reportCount > 1 ? ` (${zone.reportCount} reports)` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </footer>
  );
}
