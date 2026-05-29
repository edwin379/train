# Tokyo Metro Real-time Map

This project visualizes Tokyo Metro train lines, station locations, and live train movement using MapLibre GL JS and Tokyo Metro ODPT open data.

## Files

- `index.html` — main web app
- `styles.css` — dark theme UI styling
- `app.js` — map and Tokyo Metro API logic

## Run locally

1. Open `index.html` in a browser, or run a local server for best results.
2. If using Python 3, run:

```powershell
python -m http.server 8000
```

3. Open `http://localhost:8000` in your browser.

## Notes

- The app fetches live data from Tokyo Metro ODPT APIs.
- Train markers refresh automatically every 20 seconds.
- Delayed lines and trains are highlighted in red.

