import { useCallback, useEffect, useRef, useState } from "react";

export function useGPS() {
  const [position, setPosition] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!navigator.geolocation) {
      setError("Geolocation not supported");
      return undefined;
    }

    const watchId = navigator.geolocation.watchPosition(
      pos => setPosition({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      err => setError(err.message),
      { enableHighAccuracy: true, maximumAge: 5000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  return { position, error };
}

export function useAudioAlerts() {
  const lastAlertRef = useRef(null);
  const audioContextRef = useRef(null);
  const [audioEnabled, setAudioEnabled] = useState(false);

  const enableAudio = useCallback(async () => {
    try {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (AudioContextCtor && !audioContextRef.current) {
        audioContextRef.current = new AudioContextCtor();
      }

      if (audioContextRef.current?.state === "suspended") {
        await audioContextRef.current.resume();
      }

      if ("speechSynthesis" in window) {
        window.speechSynthesis.getVoices();
        const primer = new SpeechSynthesisUtterance("");
        primer.volume = 0;
        window.speechSynthesis.speak(primer);
      }

      setAudioEnabled(true);
      return true;
    } catch (_) {
      setAudioEnabled(false);
      return false;
    }
  }, []);

  const triggerAlert = useCallback((threatLevel) => {
    if (!audioEnabled) return;
    if (lastAlertRef.current === threatLevel) return;

    lastAlertRef.current = threatLevel;
    setTimeout(() => {
      lastAlertRef.current = null;
    }, 8000);

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(
        threatLevel === "RED"
          ? "Danger ahead. Immediate threat detected. Consider turning back now."
          : "Caution. Hazard detected on the road ahead. Proceed with care."
      );
      utterance.rate = 1;
      utterance.volume = 1;
      utterance.pitch = threatLevel === "RED" ? 0.8 : 1;

      const englishVoice = window.speechSynthesis
        .getVoices()
        .find(voice => voice.lang.startsWith("en"));

      if (englishVoice) {
        utterance.voice = englishVoice;
      }

      window.speechSynthesis.speak(utterance);
    }

    if (threatLevel === "RED") {
      try {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        const audioContext = audioContextRef.current || new AudioContextCtor();
        audioContextRef.current = audioContext;
        const gain = audioContext.createGain();
        gain.connect(audioContext.destination);

        for (let index = 0; index < 3; index += 1) {
          const oscillator = audioContext.createOscillator();
          oscillator.connect(gain);
          oscillator.type = "sawtooth";
          oscillator.frequency.setValueAtTime(880, audioContext.currentTime + index * 0.4);
          oscillator.frequency.exponentialRampToValueAtTime(440, audioContext.currentTime + index * 0.4 + 0.35);
          gain.gain.setValueAtTime(0.3, audioContext.currentTime + index * 0.4);
          gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + index * 0.4 + 0.38);
          oscillator.start(audioContext.currentTime + index * 0.4);
          oscillator.stop(audioContext.currentTime + index * 0.4 + 0.4);
        }
      } catch (_) {
        // Ignore audio failures so visual warnings still work.
      }
    }
  }, [audioEnabled]);

  return { audioEnabled, enableAudio, triggerAlert };
}

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";
const POLL_INTERVAL_MS = 15000;

export function useDangerZones(position) {
  const [nearbyZones, setNearbyZones] = useState([]);

  const flushQueue = useCallback(async () => {
    const queue = JSON.parse(localStorage.getItem("sr_queue") || "[]");
    if (!queue.length) return;

    for (const item of queue) {
      try {
        await fetch(`${BACKEND}/api/danger-zones`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        });
      } catch (_) {
        return;
      }
    }

    localStorage.removeItem("sr_queue");
  }, []);

  useEffect(() => {
    if (!position) return undefined;

    async function fetchNearby() {
      try {
        const response = await fetch(
          `${BACKEND}/api/danger-zones/nearby?lat=${position.lat}&lon=${position.lon}&radius=5`
        );

        if (response.ok) {
          const data = await response.json();
          setNearbyZones(data.zones || []);
        }
      } catch (_) {
        // Offline is expected; preserve the last successful result.
      }
    }

    fetchNearby();
    const intervalId = setInterval(fetchNearby, POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [position?.lat, position?.lon]);

  const reportZone = useCallback(async (payload) => {
    try {
      await fetch(`${BACKEND}/api/danger-zones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (_) {
      const queue = JSON.parse(localStorage.getItem("sr_queue") || "[]");
      queue.push(payload);
      localStorage.setItem("sr_queue", JSON.stringify(queue.slice(-20)));
    }
  }, []);

  useEffect(() => {
    flushQueue();
    window.addEventListener("online", flushQueue);
    return () => window.removeEventListener("online", flushQueue);
  }, [flushQueue]);

  return { nearbyZones, reportZone };
}
