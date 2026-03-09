// Auth0 Configuration
// Note: Update redirectUri based on your deployment environment
// - Local development: http://localhost:3000/auth-callback.html
// - Production: https://iotistic.com/auth-callback.html
const AUTH0_CONFIG = {
    domain: 'auth.iotistica.com',
    clientId: 'Q3DgGlIAoTgIhhXC7AhtJPR1ByiLXCkR',
    redirectUri: window.location.origin + '/auth-callback.html',
};

const trialModalOverlay = document.getElementById('trialModalOverlay');
const openTrialModalBtn = document.getElementById('openTrialModal');
const closeTrialModalBtn = document.getElementById('closeTrialModal');

if (openTrialModalBtn && trialModalOverlay) {
    openTrialModalBtn.addEventListener('click', () => {
        trialModalOverlay.classList.add('is-open');
        trialModalOverlay.setAttribute('aria-hidden', 'false');
        const emailInput = document.getElementById('trialEmail');
        emailInput?.focus();
    });
}

if (closeTrialModalBtn && trialModalOverlay) {
    closeTrialModalBtn.addEventListener('click', () => {
        trialModalOverlay.classList.remove('is-open');
        trialModalOverlay.setAttribute('aria-hidden', 'true');
    });
}

if (trialModalOverlay) {
    trialModalOverlay.addEventListener('click', (event) => {
        if (event.target === trialModalOverlay) {
            trialModalOverlay.classList.remove('is-open');
            trialModalOverlay.setAttribute('aria-hidden', 'true');
        }
    });
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && trialModalOverlay?.classList.contains('is-open')) {
        trialModalOverlay.classList.remove('is-open');
        trialModalOverlay.setAttribute('aria-hidden', 'true');
    }
});

// Trial Signup - Redirect to Auth0 with pre-filled email
function startTrialSignup(event) {
    event.preventDefault();
    
    const email = document.getElementById('trialEmail').value.trim();
    const company = document.getElementById('trialCompany').value.trim();
    
    if (!email || !company) {
        alert('Please fill in all fields');
        return;
    }

    trialModalOverlay?.classList.remove('is-open');
    trialModalOverlay?.setAttribute('aria-hidden', 'true');
    
    // Store company name for complete-signup API call after Auth0 callback
    sessionStorage.setItem('signupEmail', email);
    sessionStorage.setItem('signupCompany', company);
    
    // Redirect to Auth0 with email pre-filled
    const params = new URLSearchParams({
        client_id: AUTH0_CONFIG.clientId,
        redirect_uri: AUTH0_CONFIG.redirectUri,
        response_type: 'code',
        scope: 'openid profile email',
        screen_hint: 'signup',      // Force signup screen (not login)
        login_hint: email,          // Pre-fill email in Auth0 form
    });
    
    window.location.href = `https://${AUTH0_CONFIG.domain}/authorize?${params.toString()}`;
}

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

// Form submission
const contactForm = document.getElementById('contactForm');
contactForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    // Get form data
    const formData = new FormData(contactForm);
    const data = Object.fromEntries(formData);
    
    // Here you would typically send this to your backend
    console.log('Form submitted:', data);
    
    // Show success message (you can customize this)
    alert('Thank you for your message! We\'ll get back to you soon.');
    
    // Reset form
    contactForm.reset();
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
