function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

export function formatTimestamp(milliseconds, separator = ',') {
  const safe = Math.max(0, Math.round(Number(milliseconds) || 0));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const millis = safe % 1_000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(millis, 3)}`;
}

function segmentText(segment, language) {
  if (language === 'translated') {
    return segment.translated || segment.original;
  }
  return segment.original;
}

export function toSrt(segments, language = 'translated') {
  return segments
    .filter((segment) => segmentText(segment, language)?.trim())
    .map((segment, index) => {
      const start = formatTimestamp(segment.startMs, ',');
      const end = formatTimestamp(Math.max(segment.endMs, segment.startMs + 500), ',');
      return `${index + 1}\n${start} --> ${end}\n${segmentText(segment, language).trim()}\n`;
    })
    .join('\n');
}

export function toVtt(segments, language = 'translated') {
  const body = segments
    .filter((segment) => segmentText(segment, language)?.trim())
    .map((segment) => {
      const start = formatTimestamp(segment.startMs, '.');
      const end = formatTimestamp(Math.max(segment.endMs, segment.startMs + 500), '.');
      return `${start} --> ${end}\n${segmentText(segment, language).trim()}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

export function toText(segments, language = 'translated') {
  return segments
    .map((segment) => segmentText(segment, language)?.trim())
    .filter(Boolean)
    .join('\n');
}
