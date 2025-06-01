const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatLog = document.getElementById("chatLog");

let history = [];

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;

  // Show user message
  addMessageToChatLog(message, "user");
  history.push({ role: "user", content: message });
  chatInput.value = "";

  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message, history })
    });

    const data = await response.json();
    const reply = data.reply || "❌ No reply received.";
    addMessageToChatLog(reply, "agent");
    history.push({ role: "assistant", content: reply });
    chatLog.scrollTop = chatLog.scrollHeight;
  } catch (err) {
    console.error("Error:", err);
    addMessageToChatLog("❌ Server error. Try again later.", "agent");
  }
});

function addMessageToChatLog(text, sender) {
  const wrapper = document.createElement("div");
  wrapper.className = `bubble ${sender}`;

  // Use innerHTML for rich content (e.g. product cards, <strong>, <br>)
  wrapper.innerHTML = text;

  chatLog.appendChild(wrapper);
  chatLog.scrollTop = chatLog.scrollHeight;
}
document.getElementById("chatToggle").addEventListener("click", () => {
  const chat = document.getElementById("chatContainer");
  chat.classList.toggle("open");
});

