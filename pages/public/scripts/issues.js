// scripts/issues.js

function toggleNav() {
    const links = document.getElementById("nav-links");
    links.classList.toggle("open");
}

// Called by the top cards
function scrollToIssue(id) {
    setOpenIssue(id);
    const target = document.getElementById(id);
    if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// Shared logic for opening/closing issue details
function setOpenIssue(id) {
    const all = document.querySelectorAll('.issue-detail');
    all.forEach(section => {
        section.classList.remove('open');
    });

    const target = document.getElementById(id);
    if (target) {
        target.classList.add('open');
    }
}

// When the page is ready, make each detail header clickable
document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".issue-detail").forEach(section => {
        const heading = section.querySelector("h3");
        if (!heading) return;

        heading.addEventListener("click", () => {
            const isOpen = section.classList.contains("open");

            if (isOpen) {
                section.classList.remove("open");
            } else {
                setOpenIssue(section.id);
            }

            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
});