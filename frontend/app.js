const API = "https://mach-ifww.onrender.com";
let historyChart = null;

async function register() {
  const body = {
    patientName: document.getElementById("patientName").value,
    age: document.getElementById("age").value
  };

  const res = await fetch(`${API}/api/register-patient`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  localStorage.setItem("patientId", data.patientId);
  location.href = "dashboard.html";
}

async function loadLatest() {
  const patientId = localStorage.getItem("patientId");
  const res = await fetch(`${API}/api/patients/${patientId}/latest`);
  const data = await res.json();

  const valueEl = document.getElementById("value");
  const statusEl = document.getElementById("status");
  const timeEl = document.getElementById("time");
  const estimatedBadge = document.getElementById("estimatedBadge");

  valueEl.textContent = data?.glucoseValue
    ? `${data.glucoseValue} mg/dL`
    : "--";

  const statusText = data?.status || "--";
  statusEl.textContent = statusText;

  statusEl.className = "status-pill";
  if (statusText === "HIGH") statusEl.classList.add("high");
  else if (statusText === "NORMAL") statusEl.classList.add("normal");
  else if (statusText === "LOW") statusEl.classList.add("low");

  timeEl.textContent = data?.createdAt
    ? new Date(data.createdAt).toLocaleString()
    : "--";

  if (estimatedBadge) {
    estimatedBadge.hidden = !data?.estimated;
  }
}

async function loadHistory() {
  const patientId = localStorage.getItem("patientId");
  const canvas = document.getElementById("historyChart");
  if (!patientId || !canvas) return;

  const res = await fetch(`${API}/api/patients/${patientId}/history?limit=20`);
  const rows = await res.json();

  const labels = rows.map((r) => new Date(r.createdAt).toLocaleTimeString());
  const values = rows.map((r) => r.glucoseValue);

  if (historyChart) {
    historyChart.data.labels = labels;
    historyChart.data.datasets[0].data = values;
    historyChart.update();
    return;
  }

  historyChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Glucose (mg/dL)",
        data: values,
        borderColor: "#4f9dff",
        backgroundColor: "rgba(79,157,255,0.15)",
        tension: 0.3,
        fill: true
      }]
    },
    options: {
      responsive: true,
      scales: { y: { beginAtZero: false } }
    }
  });
}

async function loadDeviceStatus() {
  const el = document.getElementById("deviceStatus");
  if (!el) return;

  try {
    const res = await fetch(`${API}/api/device/status`);
    const data = await res.json();

    el.textContent = data.status || "UNKNOWN";
    el.className = "status-pill";
    if (data.status === "ON") el.classList.add("normal");
    else if (data.status === "OFF") el.classList.add("low");
    else el.classList.add("high"); // OFFLINE / UNKNOWN
  } catch (e) {
    el.textContent = "OFFLINE";
    el.className = "status-pill high";
  }
}

async function controlDevice(action) {
  try {
    await fetch(`${API}/api/device/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
    setTimeout(loadDeviceStatus, 1000);
  } catch (e) {
    alert("تعذر إرسال الأمر للجهاز — تحققي من الاتصال.");
  }
}
