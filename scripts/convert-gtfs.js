const fs = require("fs");
const path = require("path");

// Always resolve relative to THIS file
const projectDir = __dirname;
const rawDir = path.join(projectDir, "data", "raw");
const processedDir = path.join(projectDir, "data", "processed");

// Ensure output folder exists
fs.mkdirSync(processedDir, { recursive: true });

if (!fs.existsSync(rawDir)) {
  console.warn(`Raw GTFS folder not found: ${rawDir}`);
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') insideQuotes = !insideQuotes;
    else if (char === "," && !insideQuotes) {
      result.push(current.trim());
      current = "";
    } else current += char;
  }

  result.push(current.trim());
  return result;
}

function readGTFSFile(filename) {
  const filePath = path.join(rawDir, filename);
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.trim().split(/\r?\n/);

  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(parseCSVLine);

  return { headers, rows };
}

function rowsToObjects(headers, rows, keyMap = {}) {
  return rows.map(cols => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[keyMap[h] || h] = cols[i];
    });
    return obj;
  });
}

function convertCalendar() {
  try {
    const { headers, rows } = readGTFSFile("calendar.txt");

    const data = rowsToObjects(headers, rows, {
      service_id: "serviceId",
      start_date: "startDate",
      end_date: "endDate"
    });

    fs.writeFileSync(
      path.join(processedDir, "calendar.json"),
      JSON.stringify(data)
    );

    console.log("calendar.json OK");
  } catch {
    fs.writeFileSync(
      path.join(processedDir, "calendar.json"),
      JSON.stringify([])
    );
  }
}

function convertCalendarDates() {
  try {
    const { headers, rows } = readGTFSFile("calendar_dates.txt");

    const data = rowsToObjects(headers, rows, {
      service_id: "serviceId",
      exception_type: "exceptionType"
    });

    fs.writeFileSync(
      path.join(processedDir, "calendar-dates.json"),
      JSON.stringify(data)
    );

    console.log("calendar-dates.json OK");
  } catch {
    fs.writeFileSync(
      path.join(processedDir, "calendar-dates.json"),
      JSON.stringify([])
    );
    console.warn("calendar_dates.txt missing");
  }
}

// Run only what matters for now
convertCalendar();
convertCalendarDates();

console.log("DONE");