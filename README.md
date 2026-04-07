# SafeRoute AI

SafeRoute AI is a driver-focused hazard awareness app built around on-device detection, a tactical HUD, and community danger-zone reporting.

## Creator

- Anthony Onoja
- School of Health Sciences
- University of Surrey, UK
- Email: donmaston09@gmail.com

## Critical Assessment

The original app idea was strong, but the repo was not ready for production or deployment:

- the code assumed a `frontend/src/components` and `frontend/src/hooks` structure that did not exist
- the frontend was missing build-critical files like `package.json`, `main.jsx`, and `index.html`
- model readiness was driven by dead props rather than the actual TensorFlow model state
- the HUD canvas was not sized to the camera viewport, which would break overlays on real devices
- the backend accepted weakly validated input and had no deployment scaffolding

This pass turns the snapshot into a real multi-part project we can build, host, and push to GitHub.

## Project Layout

```text
backend/
  package.json
  server.js
frontend/
  android/
  capacitor.config.json
  index.html
  package.json
  vite.config.js
  src/
    App.jsx
    App.css
    main.jsx
    components/
    hooks/
python/
  hazard_detector.py
render.yaml
```

## Run Locally

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Backend:

```bash
cd backend
npm install
npm run dev
```

Python detector:

```bash
cd python
pip install ultralytics opencv-python numpy requests
python hazard_detector.py --source 0
```

Android wrapper:

```bash
npm run mobile:sync
npm run mobile:open:android
```

## Deployment Notes

- `frontend` is ready for static hosting on Render, Vercel, or Netlify
- `backend` is ready for Node hosting on Render or Railway
- set `VITE_BACKEND_URL` in the frontend host
- set `FRONTEND_ORIGIN` in the backend host if you want tighter CORS than `*`
- set `LLM_PROVIDER=openai` with `OPENAI_API_KEY` if you want OpenAI-generated context reports
- or set `LLM_PROVIDER=gemini` with `GEMINI_API_KEY` if you want Gemini-generated context reports
- optionally set `OPENAI_MODEL`, otherwise the backend uses `gpt-4.1-mini`
- optionally set `GEMINI_MODEL`, otherwise the backend uses `gemini-2.5-flash`
- for mobile packaging and Play Store prep, see [MOBILE_RELEASE.md](/Users/ao0028/Desktop/Saferoute_AI/MOBILE_RELEASE.md)

## Reliability Notes

- mobile browsers often require a one-time tap before voice alerts are allowed, so the app now includes an explicit audio unlock action
- the browser detector has been tuned to reduce false positives by requiring stronger confidence, larger objects, and short multi-frame confirmation before escalating alerts
- route/context rules now bias alerts toward objects that are central in the driver path, persistent across frames, physically relevant in the scene, and optionally corroborated by nearby community risk
