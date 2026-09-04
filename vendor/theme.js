// Headless stand-in for src/theme.js. detect.js only uses C.* for overlay
// colours, which the scanner never renders — but the import must resolve.
const C = new Proxy({}, { get: () => '#000000' });
export { C };
