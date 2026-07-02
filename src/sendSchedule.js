const DEFAULT_TIME_ZONE = "Asia/Tehran";
const DEFAULT_QUIET_START_HOUR = 2;
const DEFAULT_QUIET_END_HOUR = 8;

function zonedClock(now, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(now);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function sendSchedule(now = new Date(), options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const startHour = Number.isInteger(options.startHour) ? options.startHour : DEFAULT_QUIET_START_HOUR;
  const endHour = Number.isInteger(options.endHour) ? options.endHour : DEFAULT_QUIET_END_HOUR;
  const clock = zonedClock(now, timeZone);
  const blocked = clock.hour >= startHour && clock.hour < endHour;
  if (!blocked) return { blocked: false, timeZone, localHour: clock.hour, releaseAt: null };

  const elapsedThisHourMs = ((clock.minute * 60) + clock.second) * 1000 + now.getMilliseconds();
  const releaseAt = new Date(now.getTime() + ((endHour - clock.hour) * 60 * 60 * 1000) - elapsedThisHourMs);
  return { blocked: true, timeZone, localHour: clock.hour, releaseAt };
}

function sendGate(now = new Date(), options = {}) {
  // A fresh HIGH message may bypass quiet hours. Once a job has entered a
  // delayed/retry state it is no longer an emergency first attempt and must
  // wait until the quiet window ends, even when its priority remains HIGH.
  if (options.highPriority && !options.delayedRetry) {
    return {
      blocked: false,
      bypassed: true,
      timeZone: options.timeZone || DEFAULT_TIME_ZONE,
      releaseAt: null
    };
  }
  return { ...sendSchedule(now, options), bypassed: false };
}

module.exports = {
  DEFAULT_TIME_ZONE,
  DEFAULT_QUIET_START_HOUR,
  DEFAULT_QUIET_END_HOUR,
  zonedClock,
  sendSchedule,
  sendGate
};
