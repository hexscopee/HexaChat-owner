const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

async function sendOTP(email, otp, name) {
  const mailOptions = {
    from: `"HexaChat" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'HexaChat - Verify Your Email (OTP)',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 30px; background: #06121d; color: #fff; border-radius: 16px;">
        <h1 style="color: #00bcd4; text-align: center;">HexaChat</h1>
        <p>Hello ${name},</p>
        <p>Your verification code is:</p>
        <div style="text-align: center; margin: 30px 0;">
          <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #00bcd4; background: #092536; padding: 15px 30px; border-radius: 12px; border: 2px solid #00bcd4;">${otp}</span>
        </div>
        <p style="color: #aaa;">This code expires in 10 minutes. Do not share it with anyone.</p>
        <p style="color: #666; font-size: 12px; text-align: center; margin-top: 30px;">© 2026 HexaChat. All rights reserved.</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
}

module.exports = { sendOTP };
