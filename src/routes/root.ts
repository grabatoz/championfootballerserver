import router from "../modules/router"
import os from "os"
import { none, required } from "../modules/auth"
import { transporter } from "../modules/sendEmail"

router.get("/", none, async (ctx) => {
  ctx.response.status = 200
  ctx.response.body = {
    message: "Hello from API server",
    hostname: os.hostname(),
    fruit: "dragonfruit",
  }
})


router.get("/test", required, async (ctx) => {
  console.log(ctx.session)
  ctx.response.status = 200
})

router.post("/contact", none, async (ctx) => {
  let { name, email, message } = ctx.request.body as {
    name: string
    email: string
    message: string
  }

  await transporter.sendMail({
    to: ["huzaifahj29@gmail.com", "championfootballer@outlook.com"],
    subject: "New message from Champion Footballer contact form",
    html: `<p>From: ${name}</p>
    <p>Email address: ${email}</p>
    <p>Message: ${message}</p>`,
  })

  ctx.response.status = 200
})
