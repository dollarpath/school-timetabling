'use strict';
/*
 * School Timetabling — Node.js server
 * - Serves the web interface from /public
 * - Stores everything in data/db.json (no Google Sheets needed)
 * - Generates the timetable (random-restart search, same algorithm as the Apps Script version)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';   // set HOST=0.0.0.0 to open it to other computers on your network
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const GEN_MAX_TRIES = 100000;
const GEN_TIME_LIMIT_MS = 60 * 1000;            // stop searching after 60 seconds

/* ===================== STORAGE (JSON file) ===================== */
const EMPTY_DB = {
  classes: [],            // ['GRADE 7 A', ...]
  teachers: [],           // ['MR. JOHN DOE', ...]
  areas: [],              // [{ name, abbrev }]
  assignments: [],        // [{ class, area, abbrev, teacher, lessons, doubles }]
  structure: [],          // [{ type:'period'|'break', label, start, end }]
  settings: { schoolName: '', badge: '' },
  timetable: null         // last generated/edited { grid, days, periods, classList }
};

function loadDb() {
  const db = structuredClone(EMPTY_DB);
  try {
    const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    Object.assign(db, saved);
    db.settings = Object.assign({ schoolName: '', badge: '' }, saved.settings || {});
  } catch (e) { /* first run: start empty */ }
  return db;
}
let db = loadDb();

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);          // atomic replace so the file is never half-written
}

/* ===================== APP ===================== */
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---- startup data ---- */
app.get('/api/bootstrap', (req, res) => {
  res.json({
    classes: db.classes,
    teachers: db.teachers,
    areas: db.areas,
    schoolName: db.settings.schoolName || '',
    badge: db.settings.badge || '',
    structure: db.structure
  });
});

/* ---- classes & teachers ---- */
function simpleList(route, key) {
  app.post('/api/' + route, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.json({ success: false, message: 'Name is empty.' });
    if (db[key].some(v => v.toUpperCase() === name.toUpperCase()))
      return res.json({ success: false, message: name + ' already exists.' });
    db[key].push(name);
    saveDb();
    res.json({ success: true });
  });
  app.delete('/api/' + route + '/:name', (req, res) => {
    const target = String(req.params.name).trim().toUpperCase();
    db[key] = db[key].filter(v => v.toUpperCase() !== target);
    saveDb();
    res.json({ success: true });
  });
}
simpleList('classes', 'classes');
simpleList('teachers', 'teachers');

/* ---- learning areas ---- */
app.post('/api/areas', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const abbrev = String((req.body && req.body.abbrev) || '').trim();
  if (!name) return res.json({ success: false, message: 'Learning area name is empty.' });
  if (db.areas.some(a => a.name.toUpperCase() === name.toUpperCase()))
    return res.json({ success: false, message: name + ' already exists.' });
  db.areas.push({ name, abbrev });
  saveDb();
  res.json({ success: true });
});
app.delete('/api/areas/:name', (req, res) => {
  const target = String(req.params.name).trim().toUpperCase();
  db.areas = db.areas.filter(a => a.name.toUpperCase() !== target);
  saveDb();
  res.json({ success: true });
});

/* ---- settings: school name, badge, day structure ---- */
app.post('/api/settings', (req, res) => {
  db.settings.schoolName = String((req.body && req.body.schoolName) || '').trim();
  saveDb();
  res.json({ success: true });
});
app.post('/api/badge', (req, res) => {
  db.settings.badge = String((req.body && req.body.dataUrl) || '');
  saveDb();
  res.json({ success: true });
});
app.delete('/api/badge', (req, res) => {
  db.settings.badge = '';
  saveDb();
  res.json({ success: true });
});
app.put('/api/structure', (req, res) => {
  const list = Array.isArray(req.body && req.body.structure) ? req.body.structure : [];
  db.structure = list.map(s => ({
    type: s.type === 'break' ? 'break' : 'period',
    label: String(s.label || ''),
    start: String(s.start || ''),
    end: String(s.end || '')
  }));
  saveDb();
  res.json({ success: true });
});

/* ---- assignments ---- */
app.get('/api/assignments', (req, res) => res.json(db.assignments));
app.post('/api/assignments', (req, res) => {
  const rec = req.body || {};
  const lessons = Number(rec.lessons) || 0;
  const doubles = Number(rec.doubles) || 0;
  if (!rec.class || !rec.area || !rec.teacher)
    return res.json({ success: false, message: 'Class, learning area and teacher are required.' });
  if (lessons < 1) return res.json({ success: false, message: 'Lessons per week must be at least 1.' });
  if (2 * doubles > lessons)
    return res.json({ success: false, message: doubles + ' double(s) need ' + (2 * doubles) + ' lessons, but only ' + lessons + ' set.' });
  if (db.assignments.some(a => a.class === rec.class && a.area === rec.area))
    return res.json({ success: false, message: rec.area + ' is already assigned for ' + rec.class });
  db.assignments.push({ class: rec.class, area: rec.area, abbrev: rec.abbrev || '', teacher: rec.teacher, lessons, doubles });
  saveDb();
  res.json({ success: true });
});
app.delete('/api/assignments/:index', (req, res) => {
  const i = Number(req.params.index);
  if (Number.isInteger(i) && i >= 0 && i < db.assignments.length) {
    db.assignments.splice(i, 1);
    saveDb();
  }
  res.json({ success: true });
});

/* ---- timetable storage ---- */
app.get('/api/timetable', (req, res) => res.json({ timetable: db.timetable }));
app.put('/api/timetable', (req, res) => {
  const t = req.body || {};
  if (!t.grid || !t.days || !t.classList) return res.status(400).json({ success: false, message: 'Invalid timetable.' });
  db.timetable = { grid: t.grid, days: t.days, periods: t.periods, classList: t.classList };
  saveDb();
  let count = 0;
  t.classList.forEach(c => t.days.forEach(d => (t.grid[c][d] || []).forEach(x => { if (x) count++; })));
  res.json({ success: true, count });
});

/* ---- timetable PDF export ---- */
function pdfColumns(timetable, requestedStructure) {
  const columns = [];
  let periodIndex = 0;
  const structure = (Array.isArray(requestedStructure) ? requestedStructure : db.structure)
    .filter(segment => segment && typeof segment === 'object');
  if (structure.length) {
    structure.forEach(segment => {
      const time = segment.start && segment.end ? segment.start + ' - ' + segment.end : '';
      if (segment.type === 'period') {
        if (periodIndex < Number(timetable.periods))
          columns.push({ type: 'period', pIndex: periodIndex, label: 'P' + (periodIndex + 1), time });
        periodIndex++;
      } else {
        columns.push({ type: 'break', label: segment.label || 'Break', time });
      }
    });
  }
  for (let i = periodIndex; i < Number(timetable.periods); i++) {
    columns.push({ type: 'period', pIndex: i, label: 'P' + (i + 1), time: '' });
  }
  if (!columns.length) {
    for (let i = 0; i < Number(timetable.periods); i++) {
      columns.push({ type: 'period', pIndex: i, label: 'P' + (i + 1), time: '' });
    }
  }
  return columns;
}

function timetablePdf(doc, timetable, structure) {
  const margin = 28;
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const contentWidth = pageWidth - margin * 2;
  const pageBottom = pageHeight - margin;
  const columns = pdfColumns(timetable, structure);
  const classes = timetable.classList;
  const days = timetable.days;
  const teacherColors = [
    '#dce8f8', '#e4f2df', '#f9e3d6', '#eee2f7', '#fff1c9',
    '#dff1f0', '#f7dfe7', '#e8e9d8', '#dcecf4', '#f1e1d2'
  ];
  const teachers = new Set();
  classes.forEach(className => days.forEach(day => {
    const lessons = timetable.grid[className] && timetable.grid[className][day];
    if (Array.isArray(lessons)) lessons.forEach(lesson => {
      if (lesson && lesson.teacher) teachers.add(String(lesson.teacher));
    });
  }));
  const sortedTeachers = [...teachers].sort((a, b) => a.localeCompare(b));
  const teacherColor = {};
  sortedTeachers.forEach((teacher, index) => {
    teacherColor[teacher] = teacherColors[index % teacherColors.length];
  });
  let pageStarted = false;

  function addPage(title) {
    if (pageStarted) doc.addPage();
    pageStarted = true;
    const schoolName = db.settings.schoolName || 'School Timetable';
    const badgeMatch = String(db.settings.badge || '').match(/^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
    if (badgeMatch) {
      doc.image(Buffer.from(badgeMatch[1], 'base64'), margin, margin, { fit: [32, 32] });
    }
    const titleX = badgeMatch ? margin + 42 : margin;
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#1a4d8f')
      .text(schoolName, titleX, margin + 1, { width: pageWidth - titleX - margin, lineBreak: false, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555555')
      .text(title, titleX, margin + 21, { width: pageWidth - titleX - margin, lineBreak: false, ellipsis: true });
    return margin + 42;
  }

  function cellRect(x, y, width, height, fill) {
    doc.rect(x, y, width, height).fillAndStroke(fill, '#999999');
  }

  function fittedFontSize(text, font, maxFontSize, width, height) {
    doc.font(font).fontSize(maxFontSize);
    const lines = String(text).split(/\r?\n/);
    const measuredWidth = Math.max(1, ...lines.map(line => doc.widthOfString(line)));
    const measuredHeight = Math.max(1, doc.currentLineHeight() * lines.length);
    return Math.max(2, Math.min(
      maxFontSize,
      maxFontSize * Math.max(1, width) / measuredWidth,
      maxFontSize * Math.max(1, height) / measuredHeight
    ));
  }

  function drawCell(cell, x, y, width, height, options) {
    const value = cell && typeof cell === 'object' ? cell : { text: cell };
    const header = options.header;
    const fill = value.fill || (header ? '#eef3fa' : '#ffffff');
    cellRect(x, y, width, height, fill);
    const inset = 2;
    if (header) {
      const label = String(value.text || '');
      const labelWidth = Math.max(1, width - inset * 2);
      const labelHeight = Math.max(1, height * 0.55);
      const labelFontSize = fittedFontSize(label, 'Helvetica-Bold',
        value.fontSize || options.headerFontSize || 7, labelWidth, labelHeight);
      doc.font('Helvetica-Bold').fontSize(labelFontSize).fillColor(value.color || '#1a4d8f')
        .text(label, x + inset, y + 2, {
          width: labelWidth, height: labelHeight,
          align: 'center', valign: 'center', lineBreak: Boolean(value.multilineText), ellipsis: true
        });
      if (value.subtext) {
        const subtext = String(value.subtext);
        const subtextWidth = Math.max(1, width - inset * 2);
        const subtextHeight = Math.max(1, height * 0.4);
        const subtextFontSize = fittedFontSize(subtext, 'Helvetica',
          value.subtextFontSize || options.subheaderFontSize || 5.5,
          subtextWidth, subtextHeight);
        doc.font('Helvetica').fontSize(subtextFontSize).fillColor('#555555')
          .text(subtext, x + inset, y + height * 0.53, {
            width: subtextWidth, height: subtextHeight,
            align: 'center', valign: 'center', lineBreak: Boolean(value.multilineSubtext), ellipsis: true
          });
      }
      return;
    }
    if (value.subtext) {
      const subjectTop = y + height * 0.18;
      const subjectHeight = Math.max(1, height * 0.64);
      const subject = String(value.text || '');
      const subjectWidth = Math.max(1, width - inset * 2);
      const subjectFontSize = fittedFontSize(subject, 'Helvetica-Bold', options.fontSize || 7,
        subjectWidth, subjectHeight);
      doc.font('Helvetica-Bold').fontSize(subjectFontSize).fillColor(value.color || '#14315c')
        .text(subject, x + inset, subjectTop, {
          width: subjectWidth, height: subjectHeight,
          align: 'center', valign: 'center', lineBreak: false, ellipsis: true
        });
      const teacher = String(value.subtext);
      const teacherFont = value.subtextItalic ? 'Helvetica-Oblique' : 'Helvetica';
      const teacherWidth = Math.max(1, width - inset * 2);
      const teacherHeight = Math.max(1, height * 0.24);
      const teacherFontSize = fittedFontSize(teacher, teacherFont,
        Math.min(value.subtextFontSize || options.subFontSize || 5.5, Math.max(4, height * 0.28)),
        teacherWidth, teacherHeight);
      doc.save();
      doc.font(teacherFont).fontSize(teacherFontSize)
        .fillColor(value.subtextColor || '#39465b')
        .fillOpacity(value.subtextOpacity === undefined ? 0.45 : value.subtextOpacity)
        .text(teacher, x + inset, y + height * 0.74, {
          width: teacherWidth, height: teacherHeight,
          align: 'center', valign: 'bottom', lineBreak: false, ellipsis: true
        });
      doc.restore();
    } else {
      const font = header || value.bold ? 'Helvetica-Bold' : 'Helvetica';
      const text = String(value.text || '');
      const textWidth = Math.max(1, width - inset * 2);
      const textHeight = Math.max(1, height - 4);
      const fontSize = fittedFontSize(text, font, value.fontSize || options.fontSize || 7,
        textWidth, textHeight);
      const lineHeight = doc.font(font).fontSize(fontSize).currentLineHeight();
      const textY = value.centerVertical
        ? y + Math.max(0, (height - lineHeight) / 2)
        : y + 2;
      doc.font(font).fontSize(fontSize)
        .fillColor(value.color || '#333333')
        .text(text, x + inset, textY, {
          width: textWidth, height: textHeight,
          align: 'center', valign: 'center', lineBreak: false, ellipsis: true
        });
    }
  }

  function drawTable(x, y, widths, headers, rows, rowHeight, options) {
    let left = x;
    const headerHeight = options.headerHeight || rowHeight;
    const columnX = [];
    headers.forEach((header, index) => {
      columnX[index] = left;
      drawCell(header, left, y, widths[index], headerHeight, {
        header: true,
        headerFontSize: options.headerFontSize
      });
      left += widths[index];
    });
    y += headerHeight;
    rows.forEach((row, rowIndex) => {
      left = x;
      row.forEach((cell, index) => {
        const merged = (options.mergedCells || []).some(merge =>
          merge.column === index && rowIndex >= merge.startRow && rowIndex < merge.startRow + merge.rowCount);
        if (!merged) drawCell(cell, left, y, widths[index], rowHeight, options);
        left += widths[index];
      });
      y += rowHeight;
    });

    (options.mergedCells || []).forEach(merge => {
      const cellY = y - rows.length * rowHeight + merge.startRow * rowHeight;
      const cellHeight = merge.rowCount * rowHeight;
      const cellX = columnX[merge.column];
      if (merge.vertical) {
        cellRect(cellX, cellY, widths[merge.column], cellHeight, merge.cell.fill || '#fff4e5');
        const text = String(merge.cell.text || '');
        const textWidth = Math.max(1, cellHeight - 4);
        const textHeight = Math.max(1, widths[merge.column] - 4);
        const characterSpacing = 0.5;
        const fontSize = options.breakFontSize || 13;
        doc.font('Helvetica').fontSize(fontSize);
        const labelY = options.centerBreakLabel
          ? -doc.currentLineHeight() / 2
          : -widths[merge.column] / 2 + 2;
        doc.save();
        doc.translate(
          cellX + widths[merge.column] / 2 +
            (options.breakLabelOffsetX === undefined ? 6 : options.breakLabelOffsetX),
          cellY + cellHeight / 2
        );
        doc.rotate(270);
        doc.font('Helvetica').fontSize(fontSize).fillColor(merge.cell.color || '#a15c00')
          .text(text, -cellHeight / 2 + 2, labelY, {
            width: textWidth,
            height: textHeight,
            align: 'center',
            valign: 'center',
            characterSpacing,
            lineBreak: false,
            ellipsis: false
          });
        doc.restore();
      } else {
        drawCell(merge.cell, cellX, cellY, widths[merge.column], cellHeight, options);
      }
    });
    return y;
  }

  function periodCell(className, day, column, view) {
    const lesson = timetable.grid[className] && timetable.grid[className][day] &&
      timetable.grid[className][day][column.pIndex];
    if (!lesson) return { text: '-', fill: '#f8fafc' };
    return {
      text: lesson.abbrev || lesson.area || '',
      subtext: lesson.teacher || '',
      ...(view === 'class' ? {
        subtextColor: '#39465b',
        subtextFontSize: 5.2,
        subtextOpacity: 0.45
      } : {}),
      fill: teacherColor[String(lesson.teacher)] || '#eef3fa'
    };
  }

  function breakCell(column) {
    return {
      text: column.label,
      fill: '#fff4e5',
      color: '#a15c00'
    };
  }

  function breakMerges(columnOffset, rowCount, widths) {
    return columns.reduce((merges, column, index) => {
      if (column.type === 'break') {
        merges.push({
          column: columnOffset + index,
          startRow: 0,
          rowCount,
          cell: breakCell(column),
          vertical: true
        });
      }
      return merges;
    }, []);
  }

  function scheduleColumnWidths(availableWidth, preferredBreakWidth) {
    const breakCount = columns.filter(column => column.type === 'break').length;
    const periodCount = columns.length - breakCount;
    const breakWidth = breakCount
      ? Math.min(preferredBreakWidth, availableWidth / (breakCount + periodCount * 0.7))
      : 0;
    const periodWidth = periodCount
      ? (availableWidth - breakCount * breakWidth) / periodCount
      : availableWidth / Math.max(columns.length, 1);
    return columns.map(column => column.type === 'break' ? breakWidth : periodWidth);
  }

  function columnHeaders(first, second, compactTimes) {
    return [first, ...(second ? [second] : []), ...columns.map(column => ({
      text: compactTimes && column.type === 'break'
        ? column.label.trim().split(/\s+/).join('\n')
        : column.label,
      subtext: compactTimes && column.time ? column.time.replace(/\s*-\s*/, '\n') : column.time,
      fill: column.type === 'break' ? '#ffe9c9' : '#eef3fa',
      color: column.type === 'break' ? '#a15c00' : '#1a4d8f',
      fontSize: column.type === 'break' ? 7 : undefined,
      multilineText: Boolean(compactTimes && column.type === 'break' && /\s/.test(column.label.trim())),
      subtextFontSize: compactTimes ? 4.5 : undefined,
      multilineSubtext: Boolean(compactTimes)
    }))];
  }

  function masterRows(start, end) {
    const rows = [];
    for (let dayIndex = start; dayIndex < end; dayIndex++) {
      const day = days[dayIndex];
      classes.forEach(className => rows.push([
        { text: day }, { text: className, centerVertical: true },
        ...columns.map(column => column.type === 'break'
          ? breakCell(column)
          : periodCell(className, day, column, 'master'))
      ]));
    }
    return rows;
  }

  const masterRowHeight = 25;
  const masterWidths = [52, 72];
  const masterSlotWidths = scheduleColumnWidths(contentWidth - masterWidths[0] - masterWidths[1], 54);
  const widths = [...masterWidths, ...masterSlotWidths];
  const masterHeaders = columnHeaders('Day', 'Class');
  const allMasterRows = masterRows(0, days.length);
  let masterIndex = 0;
  while (masterIndex < allMasterRows.length || (!allMasterRows.length && !masterIndex)) {
    const y = addPage(masterIndex ? 'MASTER TIMETABLE (CONTINUED)' : 'MASTER TIMETABLE');
    const rowsPerPage = Math.max(1, Math.floor((pageBottom - y - masterRowHeight) / masterRowHeight));
    const pageRows = allMasterRows.slice(masterIndex, masterIndex + rowsPerPage);
    const mergedCells = breakMerges(2, pageRows.length, widths);
    for (let rowIndex = 0; rowIndex < pageRows.length;) {
      let end = rowIndex + 1;
      while (end < pageRows.length && pageRows[end][0].text === pageRows[rowIndex][0].text) end++;
      mergedCells.push({
        column: 0,
        startRow: rowIndex,
        rowCount: end - rowIndex,
        cell: {
          text: pageRows[rowIndex][0].text,
          fill: '#eef3fa',
          color: '#1a4d8f',
          bold: true,
          centerVertical: true
        }
      });
      rowIndex = end;
    }
    drawTable(margin, y, widths, masterHeaders, pageRows, masterRowHeight, {
      fontSize: 6.5,
      subFontSize: 5.2,
      breakFontSize: 26,
      breakLabelOffsetX: 0,
      centerBreakLabel: true,
      mergedCells
    });
    masterIndex += pageRows.length;
    if (!allMasterRows.length) masterIndex++;
  }

  classes.forEach(className => {
    const y = addPage('CLASS TIMETABLE - ' + className);
    const header = columnHeaders('Day');
    const infoY = y + 2;
    let lessonCount = 0;
    days.forEach(day => {
      const lessons = timetable.grid[className] && timetable.grid[className][day];
      if (Array.isArray(lessons)) lessons.forEach(lesson => {
        if (lesson) lessonCount++;
      });
    });
    doc.roundedRect(margin, infoY, contentWidth, 28, 4).fill('#f0f5fc');
    doc.rect(margin, infoY, 4, 28).fill('#1a4d8f');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#1a4d8f')
      .text('WEEKLY CLASS PLAN', margin + 12, infoY + 5, { lineBreak: false });
    doc.font('Helvetica').fontSize(7).fillColor('#526176')
      .text(days.length + ' school days   |   ' + timetable.periods + ' periods per day   |   ' + lessonCount + ' lessons',
        margin + 12, infoY + 16, { lineBreak: false });
    const tableY = infoY + 38;
    const classWidths = [76, ...scheduleColumnWidths(contentWidth - 76, 54)];
    const headerHeight = 32;
    const rowHeight = (pageBottom - tableY - headerHeight) / Math.max(days.length, 1);
    const rows = days.map(day => [
      {
        text: day.toUpperCase(),
        fill: '#eaf0f8',
        color: '#1a4d8f',
        bold: true,
        centerVertical: true
      },
      ...columns.map(column => column.type === 'break'
        ? breakCell(column)
        : periodCell(className, day, column, 'class'))
    ]);
    drawTable(margin, tableY, classWidths, header, rows, rowHeight, {
      fontSize: 8.5,
      subFontSize: 6.5,
      headerHeight,
      headerFontSize: 7,
      breakFontSize: 26,
      breakLabelOffsetX: 0,
      centerBreakLabel: true,
      mergedCells: breakMerges(1, rows.length, classWidths)
    });
  });

  for (let offset = 0; offset < sortedTeachers.length; offset += 4) {
    const y = addPage('TEACHER TIMETABLES');
    const cardGap = 12;
    const cardWidth = (contentWidth - cardGap) / 2;
    const cardHeight = (pageBottom - y - cardGap) / 2;
    sortedTeachers.slice(offset, offset + 4).forEach((teacher, index) => {
      const x = margin + (index % 2) * (cardWidth + cardGap);
      const top = y + Math.floor(index / 2) * (cardHeight + cardGap);
      doc.roundedRect(x, top, cardWidth, cardHeight, 4).lineWidth(0.7).stroke('#bbbbbb');
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a4d8f')
        .text(teacher, x + 5, top + 5, { width: cardWidth - 10, lineBreak: false, ellipsis: true });
      const cardWidths = [38, ...scheduleColumnWidths(cardWidth - 10 - 38, 36)];
      const cardHeaders = columnHeaders('Day', undefined, true);
      const cardRows = days.map(day => [
        {
          text: day.toUpperCase(),
          fill: '#eef3fa',
          color: '#1a4d8f',
          bold: true,
          centerVertical: true
        },
        ...columns.map(column => {
          if (column.type === 'break') return breakCell(column);
          const foundClass = classes.find(className => {
            const lesson = timetable.grid[className] && timetable.grid[className][day] &&
              timetable.grid[className][day][column.pIndex];
            return lesson && String(lesson.teacher) === teacher;
          });
          if (!foundClass) return { text: '-' };
          const lesson = timetable.grid[foundClass][day][column.pIndex];
          return {
            text: lesson.abbrev || lesson.area || '',
            subtext: foundClass,
            subtextOpacity: 1,
            fill: teacherColor[teacher] || '#eef3fa'
          };
        })
      ]);
      const cardRowHeight = (cardHeight - 33) / (days.length + 1);
      drawTable(x + 5, top + 23, cardWidths, cardHeaders, cardRows, cardRowHeight,
        {
          fontSize: 6.5,
          subFontSize: 5.2,
          headerFontSize: 5,
          subheaderFontSize: 4.5,
          headerHeight: cardRowHeight,
          mergedCells: breakMerges(1, cardRows.length, cardWidths)
        });
    });
  }
}

app.post('/api/export/pdf', (req, res, next) => {
  const timetable = req.body || {};
  if (!timetable.grid || typeof timetable.grid !== 'object' ||
      !Array.isArray(timetable.days) || !timetable.days.length ||
      !Array.isArray(timetable.classList) || !timetable.classList.length ||
      !Number.isFinite(Number(timetable.periods)) || Number(timetable.periods) < 1) {
    return res.status(400).json({ success: false, message: 'A valid timetable is required to export a PDF.' });
  }

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  doc.on('error', next);
  doc.on('end', () => {
    const name = (db.settings.schoolName || 'school-timetable')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().replace(/[. ]+$/g, '') || 'school-timetable';
    res.type('application/pdf').attachment(name + '.pdf').send(Buffer.concat(chunks));
  });
  try {
    timetablePdf(doc, timetable, timetable.structure);
    doc.end();
  } catch (error) {
    next(error);
  }
});

/* ===================== GENERATOR ===================== */
function sortClassesNatural(arr) {
  return arr.slice().sort((a, b) => {
    const na = (String(a).match(/\d+/) || [9999])[0];
    const nb = (String(b).match(/\d+/) || [9999])[0];
    if (Number(na) !== Number(nb)) return Number(na) - Number(nb);
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  });
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function generateTimetable(cfg) {
  const days = cfg.days, periods = Number(cfg.periods);
  const assignments = db.assignments;
  if (!assignments.length) return { success: false, message: 'No assignments found. Add assignments first.' };
  if (!periods) return { success: false, message: 'No teaching periods defined. Set your day structure in Settings.' };
  if (!Array.isArray(days) || !days.length) return { success: false, message: 'No school days selected.' };

  const classes = sortClassesNatural([...new Set(assignments.map(a => a.class))]);

  function buildSessions() {
    const sessions = [];
    assignments.forEach(a => {
      const doubles = Math.min(Number(a.doubles) || 0, Math.floor(a.lessons / 2));
      const singles = a.lessons - 2 * doubles;
      for (let i = 0; i < doubles; i++)
        sessions.push({ class: a.class, area: a.area, abbrev: a.abbrev, teacher: a.teacher, len: 2, key: a.class + '|' + a.area });
      for (let i = 0; i < singles; i++)
        sessions.push({ class: a.class, area: a.area, abbrev: a.abbrev, teacher: a.teacher, len: 1, key: a.class + '|' + a.area });
    });
    return sessions;
  }

  function attempt(allowSameDayRepeats) {
    const grid = {};
    classes.forEach(c => { grid[c] = {}; days.forEach(d => grid[c][d] = new Array(periods).fill(null)); });
    const tBusy = {};      // teacher|day|period -> true
    const tCol = {};       // teacher -> how often each period index is used (spreads a teacher across periods)
    const usedDay = {};    // class|area|day -> number of sessions placed
    const isFree = (t, d, p) => !tBusy[t + '|' + d + '|' + p];

    const sessions = shuffle(buildSessions());
    sessions.sort((a, b) => b.len - a.len);   // place doubles first
    const repeatDayPenalty = days.length * periods * 3 + 1;

    const unplaced = [];
    let repeatedSessions = 0;
    sessions.forEach(s => {
      const cands = [];
      for (let di = 0; di < days.length; di++) {
        const d = days[di];
        if (!allowSameDayRepeats && usedDay[s.key + '|' + d]) continue;
        for (let p = 0; p <= periods - s.len; p++) {
          let ok = true;
          for (let k = 0; k < s.len; k++) {
            if (grid[s.class][d][p + k]) { ok = false; break; }
            if (!isFree(s.teacher, d, p + k)) { ok = false; break; }
          }
          if (ok) cands.push({ d, p });
        }
      }
      if (!cands.length) { unplaced.push(s); return; }

      let best = null, bestScore = 1e9;
      cands.forEach(c => {
        let score = 0;
        const col = tCol[s.teacher] || [];
        for (let k = 0; k < s.len; k++) score += (col[c.p + k] || 0) * 3;
        score += (usedDay[s.key + '|' + c.d] || 0) * repeatDayPenalty;
        score += Math.random() * 2;
        if (score < bestScore) { bestScore = score; best = c; }
      });

      const d = best.d, p = best.p;
      for (let k = 0; k < s.len; k++) {
        grid[s.class][d][p + k] = { abbrev: s.abbrev, area: s.area, teacher: s.teacher, dbl: s.len === 2 };
        tBusy[s.teacher + '|' + d + '|' + (p + k)] = true;
        tCol[s.teacher] = tCol[s.teacher] || new Array(periods).fill(0);
        tCol[s.teacher][p + k]++;
      }
      const dayKey = s.key + '|' + d;
      if (usedDay[dayKey]) repeatedSessions++;
      usedDay[dayKey] = (usedDay[dayKey] || 0) + 1;
    });

    return { grid, unplaced, repeatedSessions };
  }

  let best = null, tries = 0;
  const startMs = Date.now();
  const strictTryLimit = Math.max(1, Math.floor(GEN_MAX_TRIES * 0.1));
  const strictTimeLimit = GEN_TIME_LIMIT_MS * 0.1;
  for (let i = 0; i < strictTryLimit && Date.now() - startMs < strictTimeLimit; i++) {
    tries++;
    const result = attempt(false);
    if (!best || result.unplaced.length < best.unplaced.length) best = result;
    if (result.unplaced.length === 0) break;
  }
  for (let i = tries; (!best || best.unplaced.length > 0) &&
      i < GEN_MAX_TRIES && Date.now() - startMs < GEN_TIME_LIMIT_MS; i++) {
    tries++;
    const result = attempt(true);
    if (!best || result.unplaced.length < best.unplaced.length ||
        (result.unplaced.length === best.unplaced.length &&
         result.repeatedSessions < best.repeatedSessions)) {
      best = result;
    }
    if (best.unplaced.length === 0) break;
    if (Date.now() - startMs > GEN_TIME_LIMIT_MS) break;
  }

  const agg = {};
  best.unplaced.forEach(s => {
    const k = s.class + '|' + s.area;
    agg[k] = agg[k] || { class: s.class, area: s.area, remaining: 0 };
    agg[k].remaining += s.len;
  });
  const unplaced = Object.keys(agg).map(k => agg[k]);

  let slots = 0;
  classes.forEach(c => days.forEach(d => best.grid[c][d].forEach(x => { if (x) slots++; })));

  const result = { grid: best.grid, days, periods, classList: classes };
  db.timetable = result;
  saveDb();

  return {
    success: true,
    message: 'Generated ' + slots + ' lesson slots across ' + classes.length + ' class(es) in ' + tries + ' attempt(s).',
    stats: { slots, classes: classes.length, unplaced },
    grid: result.grid, days, periods, classList: classes
  };
}

app.post('/api/generate', (req, res) => {
  res.json(generateTimetable(req.body || {}));
});

/* ===================== ERRORS + START ===================== */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: err.message || 'Server error' });
});

app.listen(PORT, HOST, () => {
  console.log('School Timetabling is running:  http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  console.log('Your data is stored in:        ' + DB_FILE);
});
