const nodemailer = require("nodemailer");
require("dotenv").config();

// ─────────────────────────────────────────────
//  Create reusable SMTP transporter
// ─────────────────────────────────────────────
const createTransporter = () => {
  return nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
};

// ─────────────────────────────────────────────
//  Welcome email — sent on user registration
// ─────────────────────────────────────────────
async function sendWelcomeEmail(user) {
  const transporter = createTransporter();

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: user.email,
    subject: "Welcome to Virtual Event Platform!",
    text:
      `Hi ${user.name},\n\n` +
      `Welcome to the Virtual Event Platform!\n\n` +
      `Your account details:\n` +
      `  Name  : ${user.name}\n` +
      `  Email : ${user.email}\n` +
      `  Role  : ${user.role}\n\n` +
      (user.role === "organizer"
        ? `As an organizer, you can create and manage events.\n\n`
        : `As an attendee, you can browse and register for events.\n\n`) +
      `If you did not create this account, please ignore this email.\n\n` +
      `- Virtual Event Platform`,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Welcome email sent to ${user.email}`);
  } catch (error) {
    console.error(`Error sending welcome email to ${user.email}:`, error);
  }
}

// ─────────────────────────────────────────────
//  Event registration confirmation email
//  — sent when attendee registers for an event
// ─────────────────────────────────────────────
async function sendEventRegistrationEmail(user, event) {
  const transporter = createTransporter();

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: user.email,
    subject: `Registration Confirmed: ${event.title}`,
    text:
      `Hi ${user.name},\n\n` +
      `Your registration has been confirmed for the following event:\n\n` +
      `  Event     : ${event.title}\n` +
      `  Date      : ${new Date(event.date).toDateString()}\n` +
      `  Time      : ${event.time}\n` +
      `  Details   : ${event.description}\n` +
      `  Organizer : ${event.organizerName}\n\n` +
      `We look forward to seeing you there!\n\n` +
      `To cancel, log in and unregister from the event.\n\n` +
      `- Virtual Event Platform`,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Registration email sent to ${user.email}`);
  } catch (error) {
    console.error(`Error sending registration email to ${user.email}:`, error);
  }
}

// ─────────────────────────────────────────────
//  Event update notification email
//  — sent to all participants when event is updated
// ─────────────────────────────────────────────
async function sendEventUpdateEmail(participants, event) {
  const transporter = createTransporter();

  const emailPromises = participants.map(async (participant) => {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: participant.email,
      subject: `Event Updated: ${event.title}`,
      text:
        `Hi ${participant.name},\n\n` +
        `An event you registered for has been updated:\n\n` +
        `  Event    : ${event.title}\n` +
        `  New Date : ${new Date(event.date).toDateString()}\n` +
        `  New Time : ${event.time}\n` +
        `  Details  : ${event.description}\n\n` +
        `Please update your schedule accordingly.\n\n` +
        `- Virtual Event Platform`,
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`Update email sent to ${participant.email}`);
    } catch (error) {
      console.error(`Error sending update email to ${participant.email}:`, error);
    }
  });

  await Promise.all(emailPromises);
}

module.exports = {
  sendWelcomeEmail,
  sendEventRegistrationEmail,
  sendEventUpdateEmail,
};