/* ------------------------------------------------------------------
   NOCTURNE / shared configuration
------------------------------------------------------------------- */

(() => {
  const config = {
    // CCF usually schedules CSP-S Round 1 on the third Saturday of September.
    // Update this single value when the official 2027 calendar is published.
    targetISO: "2027-09-18T09:00:00+08:00",
    weatherUrl: [
      "https://api.open-meteo.com/v1/forecast",
      "?latitude=41.74&longitude=86.17",
      "&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m",
      "&daily=temperature_2m_max,temperature_2m_min",
      "&timezone=auto&forecast_days=1",
    ].join(""),
    storageKeys: Object.freeze({
      tasks: "nocturne.agenda.v1",
      apiKey: "nocturne.deepseek.key.v1",
    }),
  };

  Object.freeze(config);
  window.NOCTURNE_CONFIG = config;
})();
