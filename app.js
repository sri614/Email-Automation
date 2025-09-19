require("dotenv").config();
const express = require("express");
const session = require("express-session");
const { engine } = require("express-handlebars");
const connectDB = require("./service/database.js");
const methodOverride = require("method-override");
const adminRoutes = require("./routes/adminRoutes.js");
const hubspotListRoutes = require('./routes/hubspotRoute.js');
const ClonerRoutes = require('./routes/cloner.js');
const authRoutes = require('./routes/auth');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(methodOverride('_method'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'secret123',
    resave: false,
    saveUninitialized: false
}));

// ✅ Make session.user available to all views as {{user}}
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// View Engine Setup
app.engine("hbs", engine({
    extname: ".hbs",
    layoutDir: "views/layouts/",
    defaultLayout: "main-layout",
    helpers: {
        isActive: function (activePage, currentPage) {
            return activePage === currentPage ? "active" : "";
        },
        isType: function (isMain, currentType) {
            isMain = currentType.toLowerCase().includes("main");
            return isMain ? "mainStyle" : "subStyle";
        }
    },
}));
app.set("view engine", "hbs");
app.set("views", "views");

// DB Connection
connectDB();

// Routes
app.use("/", authRoutes);         // 👈 Login & logout
app.use("/", adminRoutes);        // 👈 Protected routes
app.use('/api', hubspotListRoutes);
app.use('/api', ClonerRoutes);

// Test route (optional)
app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.send(`Welcome to Dashboard, ${req.session.user}`);
});

// Server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}/`);
});
