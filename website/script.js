// Mobile menu toggle
const navToggle = document.getElementById('navToggle');
const navMenu = document.getElementById('navMenu');

navToggle.addEventListener('click', () => {
    navMenu.classList.toggle('active');
});

// Close mobile menu when clicking a link
const navLinks = document.querySelectorAll('.nav-link');
navLinks.forEach(link => {
    link.addEventListener('click', () => {
        navMenu.classList.remove('active');
    });
});

// Smooth scrolling for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});


// Add scroll effect to navbar
let lastScroll = 0;
const navbar = document.querySelector('.navbar');

window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset;
    
    if (currentScroll > 100) {
        navbar.style.background = 'rgba(10, 10, 10, 0.98)';
        navbar.style.boxShadow = '0 2px 20px rgba(0, 0, 0, 0.3)';
    } else {
        navbar.style.background = 'rgba(10, 10, 10, 0.95)';
        navbar.style.boxShadow = 'none';
    }
    
    lastScroll = currentScroll;
});

// Intersection Observer for fade-in animations
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
        }
    });
}, observerOptions);

// Observe service cards and other elements for animation
document.querySelectorAll('.service-card, .about-feature, .stat-card, .contact-card').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    observer.observe(el);
});

// Open signup page (full page, not modal)
function openSignupModal() {
    window.location.href = 'signup.html';
}

// HubSpot form — inject dark styles once it renders
const hsContainer = document.querySelector('.hs-form-frame');
if (hsContainer) {
    const hsStyles = `
        .hbspt-form form { background: transparent !important; }
        .hbspt-form .hs-richtext, .hbspt-form .hs-richtext p { display: none !important; }
        .hbspt-form fieldset { max-width: 100% !important; }
        .hbspt-form .hs-form-field { margin-bottom: 1.2rem !important; width: 100% !important; float: none !important; }
        .hbspt-form label { color: rgba(255,255,255,0.65) !important; font-size: 0.85rem !important; font-weight: 500 !important; margin-bottom: 0.4rem !important; display: block !important; }
        .hbspt-form .hs-form-required { color: #f87171 !important; }
        .hbspt-form input[type=text], .hbspt-form input[type=email], .hbspt-form input[type=tel], .hbspt-form textarea, .hbspt-form select {
            background: rgba(255,255,255,0.06) !important;
            border: 1px solid rgba(255,255,255,0.15) !important;
            border-radius: 8px !important;
            color: #ffffff !important;
            font-size: 0.95rem !important;
            padding: 0.8rem 1rem !important;
            width: 100% !important;
            box-sizing: border-box !important;
            box-shadow: none !important;
        }
        .hbspt-form input:focus, .hbspt-form textarea:focus { border-color: #3b82f6 !important; outline: none !important; }
        .hbspt-form input[type=submit], .hbspt-form .hs-button {
            background: linear-gradient(135deg, #006a67, #3b82f6) !important;
            color: #fff !important; border: none !important; border-radius: 8px !important;
            padding: 0.9rem 2rem !important; font-size: 1rem !important; font-weight: 600 !important;
            cursor: pointer !important; width: 100% !important; margin-top: 0.5rem !important;
        }
        .hbspt-form input[type=submit]:hover { opacity: 0.85 !important; }
        .hbspt-form .hs-error-msgs { color: #f87171 !important; font-size: 0.8rem !important; list-style: none !important; padding: 0 !important; margin-top: 0.3rem !important; }
        .hbspt-form .submitted-message { color: #00d4aa !important; text-align: center !important; padding: 2rem 0 !important; font-size: 1rem !important; }
    `;
    const mo = new MutationObserver(() => {
        if (hsContainer.querySelector('form')) {
            const tag = document.createElement('style');
            tag.textContent = hsStyles;
            hsContainer.prepend(tag);
            mo.disconnect();
        }
    });
    mo.observe(hsContainer, { childList: true, subtree: true });
}

// Custom contact form (pages without HubSpot embed)
const contactForm = document.getElementById('contactForm');
if (contactForm) {
    contactForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = contactForm.querySelector('button[type="submit"]');
        const status = document.getElementById('cf-status');
        btn.disabled = true;
        btn.textContent = 'Sending…';
        const payload = {
            fields: [
                { name: 'firstname', value: document.getElementById('cf-firstname').value },
                { name: 'lastname',  value: document.getElementById('cf-lastname').value },
                { name: 'email',     value: document.getElementById('cf-email').value },
                { name: 'message',   value: document.getElementById('cf-message').value },
            ],
            context: { pageUri: window.location.href, pageName: document.title },
        };
        try {
            const res = await fetch(
                'https://api.hsforms.com/submissions/v3/integration/submit/22522953/bf214b77-45da-48a2-8030-bef3601d7363',
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
            );
            if (res.ok) {
                status.style.color = '#00d4aa';
                status.textContent = "Thanks — we'll be in touch within one business day.";
                contactForm.reset();
            } else { throw new Error(res.status); }
        } catch {
            status.style.color = '#f87171';
            status.textContent = 'Something went wrong. Please try again.';
        } finally {
            status.style.display = 'block';
            btn.disabled = false;
            btn.textContent = 'Send Message';
        }
    });
}
