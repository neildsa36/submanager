const express = require("express");
const mysql = require("mysql");
const bodyParser = require("body-parser");
const cors = require("cors");
const nodemailer = require("nodemailer");
const cron = require("node-cron");
const PDFDocument = require("pdfkit");
const path = require("path");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// MySQL
const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "",
    database: "submanager",
    port: 3307
});

db.connect(err => {
    if (err) throw err;
    console.log("MySQL Connected");
});

// REGISTER
app.post("/register", (req, res) => {
    db.query("INSERT INTO users (email,password) VALUES (?,?)",
    [req.body.email, req.body.password],
    (err)=> {
        if(err) return res.send("User exists");
        res.send("Registered");
    });
});

// LOGIN
app.post("/login", (req, res) => {
    db.query("SELECT * FROM users WHERE email=? AND password=?",
    [req.body.email, req.body.password],
    (err,result)=>{
        if(result.length>0) res.send("Success");
        else res.status(401).send("Invalid");
    });
});

// ADD SUB
app.post("/addSub",(req,res)=>{

let {email,name,amount,billing_cycle,renewal_date,reminder_days,reminder_type} = req.body;

reminder_days = reminder_days || 1;
reminder_type = reminder_type || "hour";

db.query(`INSERT INTO subscriptions 
(user_email,name,amount,billing_cycle,renewal_date,reminder_days,reminder_type,expired_notified)
VALUES (?,?,?,?,?,?,?,0)`,
[email,name,amount,billing_cycle,renewal_date,reminder_days,reminder_type],
(err)=>{
    if(err) throw err;
    res.send("Added");
});
});

// GET SUBS
app.get("/subs/:email", (req, res) => {
    db.query("SELECT * FROM subscriptions WHERE user_email=?",
    [req.params.email],
    (err,result)=> res.json(result));
});

// DELETE
app.post("/delete", (req, res) => {
    db.query("DELETE FROM subscriptions WHERE id=?",
    [req.body.id],
    ()=> res.send("Deleted"));
});

// UPDATE
app.post("/update",(req,res)=>{

let {id,name,amount,billing_cycle,renewal_date,reminder_days,reminder_type} = req.body;

db.query(`UPDATE subscriptions 
SET name=?, amount=?, billing_cycle=?, renewal_date=?, reminder_days=?, reminder_type=? 
WHERE id=?`,
[name,amount,billing_cycle,renewal_date,reminder_days,reminder_type,id],
(err)=>{
    if(err) throw err;
    res.send("Updated");
});
});

// SUMMARY (ACTIVE ONLY)
app.get("/summary/:email", (req,res)=>{
    db.query("SELECT * FROM subscriptions WHERE user_email=?",
    [req.params.email],
    (err,result)=>{

        let m=0,y=0;

        result.forEach(s=>{
            let today = new Date();
            let renewal = new Date(s.renewal_date);

            today.setHours(0,0,0,0);
            renewal.setHours(0,0,0,0);

            if(renewal < today) return;

            let amt = parseFloat(s.amount);

            if(s.billing_cycle=="daily"){
                m += amt * 30;
                y += amt * 365;
            }
            else if(s.billing_cycle=="weekly"){
                m += amt * 4;
                y += amt * 52;
            }
            else if(s.billing_cycle=="monthly"){
                m += amt;
                y += amt * 12;
            }
            else{
                y += amt;
                m += amt / 12;
            }
        });

        res.json({
            monthly:m.toFixed(2),
            yearly:y.toFixed(2)
        });
    });
});

// DUE ALERT
app.get("/due/:email", (req, res) => {

    db.query("SELECT * FROM subscriptions WHERE user_email=?",
    [req.params.email],
    (err, result) => {

        let today = new Date();
        let dueList = [];

        result.forEach(sub => {
            let renewal = new Date(sub.renewal_date);
            let diff = Math.ceil((renewal - today) / (1000 * 60 * 60 * 24));

            if(diff <= 1 && diff >= 0){
                dueList.push(sub);
            }
        });

        res.json(dueList);
    });
});

// 📧 EMAIL SYSTEM
cron.schedule("* * * * *", async () => {

    console.log("Checking reminders...");

    const transporter = nodemailer.createTransport({
        service:"gmail",
        auth:{
            user:"neildsa79@gmail.com",
            pass:"xiytcfptmcjzguti"
        }
    });

    db.query("SELECT * FROM subscriptions", async (err, result) => {

        if(err) return console.log(err);

        let now = new Date();
        now.setHours(0,0,0,0);

        for (let sub of result) {

            let renewal = new Date(sub.renewal_date);
            renewal.setHours(0,0,0,0);

            let diff = Math.ceil((renewal - now) / (1000 * 60 * 60 * 24));

            let shouldSend = false;
            let current = new Date();

            if(sub.reminder_type === "minute"){
                shouldSend = true;
            }
            else if(sub.reminder_type === "hour"){
                if(current.getMinutes() === 0){
                    shouldSend = true;
                }
            }
            else if(sub.reminder_type === "2hour"){
                if(current.getMinutes() === 0 && current.getHours() % 2 === 0){
                    shouldSend = true;
                }
            }

            // ❌ EXPIRED
            if(diff < 0 && sub.expired_notified == 0){

                console.log("Sending expired email to:", sub.user_email);

                await transporter.sendMail({
                    from:"neildsa79@gmail.com",
                    to: sub.user_email,
                    subject:"❌ Subscription Expired",
                    html: `
                    <div style="font-family:Arial;background:#f1f5f9;padding:20px">
                        <div style="background:white;padding:20px;border-radius:10px">
                            <h2 style="color:red">Subscription Expired ❌</h2>

                            <p>Your subscription has expired:</p>

                            <div style="background:#fee2e2;padding:10px;border-radius:8px">
                                <b>${sub.name}</b><br>
                                Amount: ₹${sub.amount}<br>
                                Expired On: ${sub.renewal_date}
                            </div>

                            <p style="margin-top:15px">Please renew it soon.</p>
                        </div>
                    </div>
                    `
                });

                db.query("UPDATE subscriptions SET expired_notified=1 WHERE id=?", [sub.id]);

                console.log("Expired email sent:", sub.name);
            }

            // ⚠️ DUE
            else if(shouldSend && diff <= sub.reminder_days && diff >= 0){

                console.log("Sending reminder email to:", sub.user_email);

                await transporter.sendMail({
                    from:"neildsa79@gmail.com",
                    to: sub.user_email,
                    subject:"⚠ Subscription Reminder",
                    html: `
                    <div style="font-family:Arial;background:#f1f5f9;padding:20px">
                        <div style="background:white;padding:20px;border-radius:10px">
                            <h2 style="color:#3b82f6">Reminder ⚠</h2>

                            <p>Your subscription is due soon:</p>

                            <div style="background:#e2e8f0;padding:10px;border-radius:8px">
                                <b>${sub.name}</b><br>
                                Amount: ₹${sub.amount}<br>
                                Renewal Date: ${sub.renewal_date}
                            </div>

                            <p style="margin-top:15px">Don’t forget to renew it.</p>
                        </div>
                    </div>
                    `
                });

                console.log("Reminder sent:", sub.name);
            }
        }
    });

});

// 📄 PDF REPORT
app.get("/report/:email", (req, res) => {

    db.query("SELECT * FROM subscriptions WHERE user_email=?",
    [req.params.email],
    (err, result) => {

        if(err) return res.send("DB Error");

        const doc = new PDFDocument({ margin: 50 });

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", "attachment; filename=report.pdf");

        doc.pipe(res);

        try {
            const logo = path.join(__dirname, "public", "logo.png");
            doc.image(logo, 50, 40, { width: 50 });
        } catch(e){
            console.log("Logo not found");
        }

        doc.fontSize(20).text("Subscription Report", 120, 50);
        doc.moveDown(2);

        let m=0,y=0;

        result.forEach(s=>{
            let today = new Date();
            let renewal = new Date(s.renewal_date);

            today.setHours(0,0,0,0);
            renewal.setHours(0,0,0,0);

            let status = renewal < today ? "Expired ❌" : "Active ✅";

            let amt = parseFloat(s.amount);

            if(renewal >= today){
                if(s.billing_cycle=="daily"){
                    m += amt * 30;
                    y += amt * 365;
                }
                else if(s.billing_cycle=="weekly"){
                    m += amt * 4;
                    y += amt * 52;
                }
                else if(s.billing_cycle=="monthly"){
                    m += amt;
                    y += amt * 12;
                }
                else{
                    y += amt;
                    m += amt / 12;
                }
            }

            doc.text(`Service: ${s.name}`);
            doc.text(`Amount: ₹${s.amount}`);
            doc.text(`Cycle: ${s.billing_cycle}`);
            doc.text(`Date: ${s.renewal_date}`);
            doc.text(`Status: ${status}`);
            doc.moveDown();
        });

        doc.moveDown();
        doc.text(`Monthly: ₹${m.toFixed(2)}`);
        doc.text(`Yearly: ₹${y.toFixed(2)}`);

        doc.end();
    });
});

app.listen(3000,()=>console.log("Server running"));