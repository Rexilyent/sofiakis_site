document.addEventListener("DOMContentLoaded", () => {

  const url = window.location.href;
  const title = document.querySelector("h1")?.innerText || document.title;

  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(title);

  const links = {
    x: `https://twitter.com/intent/tweet?text=${encodedTitle}&url=${encodedUrl}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
    email: `mailto:?subject=${encodedTitle}&body=${encodedUrl}`
  };

  const xBtn = document.querySelector(".share-x");
  const fbBtn = document.querySelector(".share-facebook");
  const liBtn = document.querySelector(".share-linkedin");
  const emailBtn = document.querySelector(".share-email");

  if (xBtn) xBtn.href = links.x;
  if (fbBtn) fbBtn.href = links.facebook;
  if (liBtn) liBtn.href = links.linkedin;
  if (emailBtn) emailBtn.href = links.email;

  const copyBtn = document.querySelector(".share-copy");

  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(url);
      copyBtn.classList.add("copied");

      setTimeout(() => {
        copyBtn.classList.remove("copied");
      }, 2000);
    });
  }

});