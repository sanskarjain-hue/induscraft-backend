const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Verify SMTP connection on startup
transporter.verify((err, success) => {
  if (err) {
    console.error("SMTP connection failed:", err.message);
  } else {
    console.log("SMTP ready — emails will send");
  }
});

async function sendEmail({ to, subject, html }) {
  try {
    console.log(`Attempting to send email to ${to}...`);
    const info = await transporter.sendMail({
      from: `"Induscraft OMS" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`Email sent to ${to}: ${subject} — MessageId: ${info.messageId}`);
  } catch (err) {
    console.error("Email error:", err.message);
    console.error("Email error detail:", err);
  }
}

// New order created — notify Yash
async function notifyNewOrder(order) {
  console.log(`notifyNewOrder called for order ${order.id}`);
  const itemList = order.items
    .map(i => `<li>${i.name} × ${i.qty} — ₹${i.price.toLocaleString("en-IN")}</li>`)
    .join("");

  await sendEmail({
    to: process.env.EMAIL_TO_YASH,
    subject: `New Order: ${order.id} — ${order.customer.name}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #C0392B; padding: 16px 24px;">
          <h2 style="color: white; margin: 0; font-size: 18px;">New Order Created</h2>
        </div>
        <div style="padding: 24px; border: 1px solid #eee;">
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
            <tr><td style="padding: 6px 0; color: #666; width: 140px;">Order ID</td><td style="padding: 6px 0; font-weight: 600;">${order.id}</td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Channel</td><td style="padding: 6px 0;">${order.channel}</td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Customer</td><td style="padding: 6px 0;">${order.customer.name}</td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Phone</td><td style="padding: 6px 0;">${order.customer.phone || "—"}</td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Salesperson</td><td style="padding: 6px 0;">${order.salesperson}</td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Order value</td><td style="padding: 6px 0; font-weight: 600;">₹${order.value.toLocaleString("en-IN")}</td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Delivery date</td><td style="padding: 6px 0;">${order.items[0]?.originalDelivery || "—"}</td></tr>
          </table>
          <div style="margin-bottom: 8px; color: #666; font-size: 13px;">Items ordered:</div>
          <ul style="margin: 0; padding-left: 20px; font-size: 13px;">${itemList}</ul>
          <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
            Induscraft OMS — ${new Date().toLocaleDateString("en-GB")}
          </div>
        </div>
      </div>
    `,
  });
}

// Delay logged — notify Yash + salesperson
async function notifyDelay(order, itemName, delayDays, salespersonEmail) {
  const recipients = [process.env.EMAIL_TO_YASH];
  if (salespersonEmail && salespersonEmail !== process.env.EMAIL_TO_YASH) {
    recipients.push(salespersonEmail);
  }

  await sendEmail({
    to: recipients.join(","),
    subject: `Delay Alert: ${order.id} — ${itemName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #BA7517; padding: 16px 24px;">
          <h2 style="color: white; margin: 0; font-size: 18px;">⚠ Delivery Delay</h2>
        </div>
        <div style="padding: 24px; border: 1px solid #eee;">
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
            <tr><td style="padding: 6px 0; color: #666; width: 140px;">Order ID</td><td style="padding: 6px 0; font-weight: 600;">${order.id}</td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Customer</td><td style="padding: 6px 0;">${order.customer.name}</td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Item</td><td style="padding: 6px 0;">${itemName}</td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Delay</td><td style="padding: 6px 0; font-weight: 600; color: #C0392B;">${delayDays} days</td></tr>
            <tr><td style="padding: 6px 0; color: #666;">Salesperson</td><td style="padding: 6px 0;">${order.salesperson}</td></tr>
          </table>
          <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #999;">
            Induscraft OMS — ${new Date().toLocaleDateString("en-GB")}
          </div>
        </div>
      </div>
    `,
  });
}

module.exports = { notifyNewOrder, notifyDelay };