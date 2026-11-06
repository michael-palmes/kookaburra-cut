const SIGNAL = `<svg width="19" height="12" viewBox="0 0 19 12" fill="currentColor"><rect x="0" y="8" width="3.2" height="4" rx="1"/><rect x="5" y="5.5" width="3.2" height="6.5" rx="1"/><rect x="10" y="3" width="3.2" height="9" rx="1"/><rect x="15" y="0" width="3.2" height="12" rx="1"/></svg>`;
const WIFI = `<svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><path d="M8.5 2.6c2.3 0 4.4.9 6 2.4l1.2-1.2A10.2 10.2 0 0 0 8.5.9 10.2 10.2 0 0 0 1.3 3.8L2.5 5a8.5 8.5 0 0 1 6-2.4z"/><path d="M8.5 5.9c1.4 0 2.7.5 3.7 1.4l1.2-1.2A7 7 0 0 0 8.5 4.2a7 7 0 0 0-4.9 1.9l1.2 1.2c1-.9 2.3-1.4 3.7-1.4z"/><path d="M8.5 9.1c.6 0 1.1.2 1.5.5L8.5 11.3 7 9.6c.4-.3.9-.5 1.5-.5z"/></svg>`;
const BATTERY = `<svg width="28" height="13" viewBox="0 0 28 13" fill="none"><rect x="0.6" y="0.6" width="23.6" height="11.8" rx="3.6" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2"/><rect x="2.4" y="2.4" width="18" height="8.2" rx="2.2" fill="currentColor"/><path d="M25.8 4.4v4.2c.8-.3 1.4-1.1 1.4-2.1s-.6-1.8-1.4-2.1z" fill="currentColor" fill-opacity="0.45"/></svg>`;

export function phoneChrome() {
  return `<div class="status"><div class="time tnum">9:41</div><div class="glyphs">${SIGNAL}${WIFI}${BATTERY}</div></div><div class="island"></div><div class="home-bar"></div>`;
}
