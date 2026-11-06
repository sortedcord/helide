"use strict";
document.getElementById("theme").addEventListener("click", event => {
  const dark = document.documentElement.classList.toggle("dark");
  event.target.textContent = dark ? "Switch to light" : "Switch to dark";
});
let count = 0;
document.getElementById("add").addEventListener("click", () => {
  const card = document.createElement("article");
  card.className = "card";
  const label = document.createElement("span"); label.className = "number"; label.textContent = "LIVE / NEW SURFACE";
  const title = document.createElement("h2"); title.textContent = `A fresh card, ${++count}.`;
  const text = document.createElement("p"); text.textContent = "Added after the page loaded. The observer should find this background and apply a tint automatically.";
  card.append(label, title, text); document.getElementById("cards").append(card);
});
