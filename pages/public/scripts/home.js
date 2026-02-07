document.addEventListener("DOMContentLoaded", () => {
  // ZIP: numeric-only, max 5 digits
  const zipInput = document.getElementById("joinZip");
  if (zipInput) {
    zipInput.addEventListener("input", () => {
      zipInput.value = zipInput.value.replace(/\D/g, "").slice(0, 5);
    });
  }

  // HOME: conditional sticky header only after passing the join section
  const body = document.body;
  if (!body.classList.contains("page-home")) return;

  const join = document.querySelector(".home-join-header");
  const header = document.querySelector(".site-header");
  if (!join || !header) return;

  function setHeaderHeightVar() {
    const h = header.getBoundingClientRect().height;
    body.style.setProperty("--home-header-h", `${Math.ceil(h)}px`);
  }

  setHeaderHeightVar();
  window.addEventListener("resize", setHeaderHeightVar);

  const io = new IntersectionObserver(
    ([entry]) => {
      const joinVisible = entry.isIntersecting;
      header.classList.toggle("is-sticky", !joinVisible);
      body.classList.toggle("has-sticky-header", !joinVisible);
    },
    { threshold: 0.01 }
  );

  io.observe(join);
});