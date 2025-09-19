const express = require('express');
const router = express.Router();

// Login page
router.get('/login', (req, res) => {
  res.render('login', {
    pageTitle: 'Login',
    activePage: 'login'
  });
});

// Handle login form
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (email.endsWith('@blueoshan.com') && password === '54321') {
    req.session.user = email;
    return res.redirect('/');
  }

  res.send('Login failed: Invalid email or password');
});

// Logout route
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
