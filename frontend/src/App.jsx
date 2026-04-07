import { useEffect, useRef, useState } from "react";
import {
  AlertBanner,
  CameraFeed,
  CommunityWarning,
  ContextReportCard,
  ControlPanel,
  SafetyActions,
} from "./components/index.jsx";
import HUDOverlay from "./components/HUDOverlay.jsx";
import { useHazardDetection } from "./hooks/useHazardDetection.js";
import {
  useAudioAlerts,
  useContextReport,
  useDangerZones,
  useGPS,
} from "./hooks/index.js";
import "./App.css";

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const [nightMode, setNightMode] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [alertProfile, setAlertProfile] = useState("conservative");
  const [reportSuppressedUntil, setReportSuppressedUntil] = useState(0);

  const { position, error: gpsError } = useGPS();
  const { nearbyZones, reportZone } = useDangerZones(position);

  const communityRiskLevel = nearbyZones.some(zone => zone.threatLevel === "RED")
    ? "RED"
    : nearbyZones.some(zone => zone.threatLevel === "YELLOW")
      ? "YELLOW"
      : "GREEN";

  const { threatLevel, detections, isProcessing, modelLoaded, reviewState } = useHazardDetection(
    videoRef,
    canvasRef,
    {
      nightMode,
      enabled: cameraReady,
      context: { communityRiskLevel, alertProfile },
    }
  );

  const { audioEnabled, enableAudio, triggerAlert } = useAudioAlerts();
  const { contextReport, isLoadingReport } = useContextReport({
    detections,
    nearbyZones,
    position,
    threatLevel,
    communityRiskLevel,
  });

  useEffect(() => {
    if (!threatLevel || threatLevel === "GREEN") return;

    triggerAlert(threatLevel);

  }, [detections, position, reportZone, threatLevel, triggerAlert]);

  const handleConfirmHazard = () => {
    if (!position || threatLevel !== "RED") return;
    reportZone({ threatLevel, detections, lat: position.lat, lon: position.lon });
    setReportSuppressedUntil(Date.now() + 60000);
  };

  const handleDismissHazard = () => {
    setReportSuppressedUntil(Date.now() + 60000);
  };

  const effectiveReviewState = reviewState.needsConfirmation && Date.now() > reportSuppressedUntil
    ? reviewState
    : { needsConfirmation: false, confidence: reviewState.confidence };

  const communityHighRisk = nearbyZones.some(zone => zone.threatLevel === "RED");
  const systemStatus = cameraError || gpsError;

  return (
    <div className={`app ${nightMode ? "night-mode" : ""} threat-${(threatLevel || "GREEN").toLowerCase()}`}>
      <header className="app-header">
        <div className="logo">
          <span className="logo-icon">⬡</span>
          <span className="logo-text">SafeRoute AI</span>
        </div>
        <div className="header-status">
          {modelLoaded ? (
            <span className="badge badge-active">AI ACTIVE</span>
          ) : (
            <span className="badge badge-loading">LOADING MODEL...</span>
          )}
          {position ? <span className="badge badge-gps">GPS LOCKED</span> : null}
        </div>
      </header>

      {systemStatus ? (
        <div className="system-banner" role="status">
          {systemStatus}
        </div>
      ) : null}

      {!audioEnabled ? (
        <div className="audio-banner">
          <div>
            <strong>Enable audio alerts</strong>
            <span>Tap once to unlock spoken warnings on mobile browsers.</span>
          </div>
          <button className="audio-enable-btn" onClick={enableAudio}>
            Enable Audio
          </button>
        </div>
      ) : null}

      <SafetyActions
        alertProfile={alertProfile}
        onAlertProfileChange={setAlertProfile}
        reviewState={effectiveReviewState}
        onConfirmHazard={handleConfirmHazard}
        onDismissHazard={handleDismissHazard}
      />

      {communityHighRisk ? <CommunityWarning zones={nearbyZones} /> : null}
      <ContextReportCard report={contextReport} isLoading={isLoadingReport} />

      <main className="main-view">
        <AlertBanner threatLevel={threatLevel} detections={detections} />

        <div className="camera-wrapper">
          <CameraFeed
            videoRef={videoRef}
            onReady={() => setCameraReady(true)}
            onError={setCameraError}
          />
          <HUDOverlay
            canvasRef={canvasRef}
            detections={detections}
            threatLevel={threatLevel}
            isProcessing={isProcessing}
            nightMode={nightMode}
          />
        </div>
      </main>

      <ControlPanel
        nightMode={nightMode}
        onNightModeToggle={() => setNightMode(value => !value)}
        threatLevel={threatLevel}
        nearbyZones={nearbyZones}
        modelReady={modelLoaded}
      />

      <div className="creator-credit" aria-label="creator information">
        <p className="creator-credit-name">Created by Anthony Onoja</p>
        <p className="creator-credit-meta">School of Health Sciences, University of Surrey, UK</p>
        <a className="creator-credit-link" href="mailto:donmaston09@gmail.com">
          donmaston09@gmail.com
        </a>
      </div>
    </div>
  );
}
