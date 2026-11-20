import { icon } from "../shared/icons.js";

export const DAYS = [
  ["Mon", 11],
  ["Tue", 12],
  ["Wed", 13],
  ["Thu", 14],
  ["Fri", 15],
  ["Sat", 16],
  ["Sun", 17],
];

export const BIRD = `<svg class="bird" viewBox="0 0 64 56" aria-hidden="true"><path d="M22 37C15 28 8 15 8.5 7.5C8.8 3.2 13.5 2.6 15.5 6.2C19.5 14 24.5 23.5 30 31z" fill="#3f7fe8"/><ellipse cx="35" cy="37.5" rx="17" ry="13" fill="#efe6d6"/><path d="M17.5 37C20 27 32 23 43 28.5C42 39 30 45.5 19.5 42.500C18 41 17.200 39 17.500 37z" fill="#8aa97b"/><circle cx="45" cy="23" r="11.5" fill="#3f7fe8"/><path d="M34.5 26.5C40 22.5 50 21.5 56.300 24.500C55.500 30 51 34.300 45 34.500C40 34.500 36 31.500 34.500 26.500z" fill="#1d3f9c"/><ellipse cx="43.5" cy="28.3" rx="5.8" ry="3.6" fill="#8fd0ff"/><path d="M55.5 20.8L63.5 23.2L55.800 26z" fill="#8a8279"/><circle cx="49.5" cy="21.3" r="1.9" fill="#0f0d0b"/></svg>`;

export const TICK = `<svg class="i" viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg>`;

export const brand = () => `<div class="brand">${BIRD}<span>Fairywren</span></div>`;

export const head = (date, title, extra = "") =>
  `<div class="glow"></div><header class="head">${brand()}<div class="eyebrow">${date}</div><h1 class="display">${title}</h1>${extra}</header>`;

export const week = (today = 1) =>
  `<div class="week" id="week">${DAYS.map(([d, n], i) => `<div class="day${i === today ? " today" : ""}${i > 4 ? " weekend" : ""}"><small>${d}</small><b class="tnum">${n}</b><i></i></div>`).join("")}</div>`;

export function block({ cls, time, title, meta, people, id = "" }) {
  const who = people
    ? `<div class="avatars">${people.map((p, i) => `<div class="avatar a${i + 1}">${p}</div>`).join("")}</div>`
    : "";
  return `<div class="block ${cls}"${id ? ` id="${id}"` : ""}><div class="body"><div class="time tnum">${time}</div><div class="title">${title}</div><div class="meta">${meta}</div></div><div class="side">${who}<div class="check">${TICK}</div></div></div>`;
}

export const dock = (on = "Today") =>
  `<div class="dock" id="dock"><nav class="tabs">${[
    ["calendar", "Today"],
    ["list", "Lists"],
    ["bars", "Insights"],
  ]
    .map(([ic, t]) => `<div class="tab${t === on ? " on" : ""}">${icon(ic)}${t}</div>`)
    .join("")}</nav><div class="add" id="add">${icon("plus")}</div></div>`;
