# School Timetabling System (VS Code / Node.js)

The same system as the Google Sheets version, running on your own computer.
Your data is saved in `data/db.json` (no Google account needed).

## What you need
- **Node.js 18 or newer** — download the LTS version from https://nodejs.org
- **VS Code** — https://code.visualstudio.com

## Run it
1. Unzip the project and open the folder in VS Code (**File → Open Folder…**).
2. Open the terminal in VS Code (**Terminal → New Terminal**).
3. Install once:
   ```
   npm install
   ```
4. Start the app:
   ```
   npm start
   ```
5. Open **http://localhost:3000** in your browser (Chrome or Edge recommended).

You can also press **F5** in VS Code to run it with the debugger.
While developing, `npm run dev` restarts the server automatically when you change `server.js`
(refresh the browser after changing `public/index.html`).

## How to use it
Same order as before:
1. **Settings** – school name, badge, and daily structure (periods and breaks with times).
2. **Classes**, **Teachers**, **Learning Areas** – add what your school has.
3. **Assignments** – pick class, learning area, teacher, lessons per week and double lessons.
4. **Generate** – create the timetable, then view Master / Class / Teacher.
   - Generation first tries to schedule each subject at most once per day. If needed to fit all required sessions, it allows same-day repeats while avoiding class and teacher clashes. A double lesson counts as one session and occupies two consecutive periods.
   - Drag lessons within a class to swap them (clashes show in red).
   - **Save Edits** stores your changes.
   - The last timetable is reloaded automatically when you open the app again.

## Export to PDF
Click **Export PDF** to download an A4 landscape PDF containing the master timetable,
one timetable per class, and teacher timetables (up to four per page). Class and
teacher timetables show configured breaks as vertically labeled, shaded columns spanning
the schedule rows, with full names in regular-weight text. Break labels use a centered
26 pt font in master and class timetables and retain their existing size and alignment in
teacher timetables. Day names are bold and centered; lesson subjects are centered, with
teacher names at the bottom of each lesson cell using the same subdued styling in master
and class timetables. Teacher timetables show full weekday names and period times.
The PDF is created directly; no print dialog or extra save step is needed.

## Where is my data? Backups
Everything is in `data/db.json`. Copy that file to back up or to move the system to another computer.
Delete it to start fresh.

## Use it from other computers on the school network (optional)
Start with the host opened up:
- Windows PowerShell: `$env:HOST="0.0.0.0"; npm start`
- Mac/Linux: `HOST=0.0.0.0 npm start`

Then other computers open `http://<this-computer's-IP>:3000`. There is no login, so only do this on a trusted network.

## Project layout
```
school-timetabling/
├─ server.js          API, JSON storage, timetable generator
├─ public/
│  └─ index.html      the whole interface
├─ data/db.json       your data (created automatically)
├─ package.json
└─ .vscode/launch.json
```

## Settings you can change
At the top of `server.js`:
- `GEN_TIME_LIMIT_MS` – how long the generator may search (default 60 seconds)
- `GEN_MAX_TRIES` – maximum number of attempts (default 100000)
- `PORT` / `HOST` – or set them as environment variables
