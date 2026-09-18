// ============================================================
// PHONE BORROWING SYSTEM — FIRESTORE BACKEND (client-side)
// Drop-in replacement for the old Apps Script `api(payload)`
// function. Same action names, same request/response shapes,
// so index.html / admin.html need almost no changes.
//
// Data model (Firestore collections):
//   agents/{slug(name)}   { name, team, pin, activeBorrowUnit, activeRecordId }
//   teams/{slug(teamName)}{ teamName, manager }
//   phones/{slug(unitNo)} { unitNo, serialNo, available, borrowedBy }
//   records/{recordId}    { recordId, agentName, unitNo, serialNo,
//                            borrowTime, returnTime, notes,
//                            clientsCalledAgent, successfulCallsAgent,
//                            clientsCalledAdmin, successfulCallsAdmin,
//                            verificationStatus }
//   admins/{slug(username)} { username, password }
//
// SECURITY NOTE: this talks to Firestore directly from the browser
// using wide-open rules (see firestore.rules). PINs and admin
// passwords are stored and compared in plain text, same trust
// level as the old Google Sheet. See MIGRATION_GUIDE.md for how
// to harden this later (Firebase Auth + Cloud Functions on Blaze).
// ============================================================

import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, runTransaction, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

function slug(s) {
  return s.toString().trim().toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\-]/g, "");
}

function toIso(ts) {
  return ts ? ts.toDate().toISOString() : "";
}

function recordToHeaderObj(v) {
  return {
    "Record ID": v.recordId,
    "Agent Name": v.agentName,
    "Phone Unit": v.unitNo,
    "Serial No.": v.serialNo,
    "Borrow Time": toIso(v.borrowTime),
    "Return Time": toIso(v.returnTime),
    "Purpose/Notes": v.notes || "",
    "Clients Called (Agent)": v.clientsCalledAgent ?? "",
    "Successful Calls (Agent)": v.successfulCallsAgent ?? "",
    "Clients Called (Admin)": v.clientsCalledAdmin ?? "",
    "Successful Calls (Admin)": v.successfulCallsAdmin ?? "",
    "Verification Status": v.verificationStatus || "Unverified",
  };
}

// ── AGENTS ──────────────────────────────────────────────────
async function getAgents() {
  const snap = await getDocs(collection(db, "agents"));
  const agents = [];
  snap.forEach((d) => {
    const v = d.data();
    agents.push({ name: v.name, team: v.team || "" });
  });
  return { success: true, agents };
}

async function addAgent(data) {
  const name = data.name.trim();
  const ref = doc(db, "agents", slug(name));
  if ((await getDoc(ref)).exists())
    return { success: false, message: "Agent already exists." };
  await setDoc(ref, {
    name,
    team: data.team ? data.team.trim() : "",
    pin: "",
    activeBorrowUnit: null,
    activeRecordId: null,
  });
  return { success: true, message: "Agent added." };
}

async function removeAgent(data) {
  const ref = doc(db, "agents", slug(data.name));
  if (!(await getDoc(ref)).exists())
    return { success: false, message: "Agent not found." };
  await deleteDoc(ref);
  return { success: true, message: "Agent removed." };
}

async function assignTeam(data) {
  const ref = doc(db, "agents", slug(data.agentName));
  if (!(await getDoc(ref)).exists())
    return { success: false, message: "Agent not found." };
  await updateDoc(ref, { team: data.team || "" });
  return { success: true, message: "Team assigned." };
}

// ── TEAMS ────────────────────────────────────────────────────
async function getTeams() {
  const snap = await getDocs(collection(db, "teams"));
  const teams = [];
  snap.forEach((d) => {
    const v = d.data();
    teams.push({ teamName: v.teamName, manager: v.manager || "" });
  });
  return { success: true, teams };
}

async function addTeam(data) {
  const ref = doc(db, "teams", slug(data.teamName));
  if ((await getDoc(ref)).exists())
    return { success: false, message: "Team already exists." };
  await setDoc(ref, {
    teamName: data.teamName.trim(),
    manager: data.manager ? data.manager.trim() : "",
  });
  return { success: true, message: "Team added." };
}

async function removeTeam(data) {
  const ref = doc(db, "teams", slug(data.teamName));
  if (!(await getDoc(ref)).exists())
    return { success: false, message: "Team not found." };
  await deleteDoc(ref);
  return { success: true, message: "Team removed." };
}

// ── PHONES ───────────────────────────────────────────────────
async function getPhones() {
  const snap = await getDocs(collection(db, "phones"));
  const phones = [];
  snap.forEach((d) => {
    const v = d.data();
    phones.push({
      unitNo: v.unitNo,
      serialNo: v.serialNo,
      available: v.available !== false,
      borrowedBy: v.borrowedBy || null,
    });
  });
  return { success: true, phones };
}

async function addPhone(data) {
  const unitNo = data.unitNo.toString().trim();
  const ref = doc(db, "phones", slug(unitNo));
  if ((await getDoc(ref)).exists())
    return { success: false, message: "Unit number already exists." };
  await setDoc(ref, {
    unitNo,
    serialNo: data.serialNo.toString().trim(),
    available: true,
    borrowedBy: null,
  });
  return { success: true, message: "Phone unit added." };
}

async function removePhone(data) {
  const ref = doc(db, "phones", slug(data.unitNo));
  if (!(await getDoc(ref)).exists())
    return { success: false, message: "Phone unit not found." };
  await deleteDoc(ref);
  return { success: true, message: "Phone unit removed." };
}

// ── BORROW / RETURN (Firestore transactions) ───────────────
async function borrowPhone(data) {
  const agentRef = doc(db, "agents", slug(data.agentName));
  const phoneRef = doc(db, "phones", slug(data.unitNo));
  const recordId = "REC-" + Date.now();
  const recordRef = doc(db, "records", recordId);

  try {
    await runTransaction(db, async (tx) => {
      const agentSnap = await tx.get(agentRef);
      const phoneSnap = await tx.get(phoneRef);
      if (!agentSnap.exists()) throw new Error("Agent not found.");
      if (!phoneSnap.exists()) throw new Error("Phone unit not found.");
      const a = agentSnap.data();
      const p = phoneSnap.data();
      if (a.activeBorrowUnit)
        throw new Error("You already have Unit " + a.activeBorrowUnit + " borrowed. Return it first.");
      if (p.available === false)
        throw new Error("This unit is currently borrowed.");

      tx.set(recordRef, {
        recordId,
        agentName: data.agentName,
        unitNo: data.unitNo,
        serialNo: data.serialNo,
        borrowTime: Timestamp.now(),
        returnTime: null,
        notes: data.notes || "",
        clientsCalledAgent: null,
        successfulCallsAgent: null,
        clientsCalledAdmin: null,
        successfulCallsAdmin: null,
        verificationStatus: "Unverified",
      });
      tx.update(phoneRef, { available: false, borrowedBy: data.agentName });
      tx.update(agentRef, { activeBorrowUnit: data.unitNo, activeRecordId: recordId });
    });
    return { success: true, message: "Phone borrowed successfully!" };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function returnPhone(data) {
  const phoneRef = doc(db, "phones", slug(data.unitNo));
  try {
    await runTransaction(db, async (tx) => {
      const phoneSnap = await tx.get(phoneRef);
      if (!phoneSnap.exists()) throw new Error("No active borrow record found.");
      const p = phoneSnap.data();
      if (!p.borrowedBy) throw new Error("No active borrow record found.");

      const agentRef = doc(db, "agents", slug(p.borrowedBy));
      const agentSnap = await tx.get(agentRef);
      if (!agentSnap.exists() || !agentSnap.data().activeRecordId)
        throw new Error("No active borrow record found.");
      const a = agentSnap.data();

      const recordRef = doc(db, "records", a.activeRecordId);
      const recordSnap = await tx.get(recordRef);
      if (!recordSnap.exists()) throw new Error("No active borrow record found.");

      tx.update(recordRef, {
        returnTime: Timestamp.now(),
        clientsCalledAgent: data.clientsCalled,
        successfulCallsAgent: data.successfulCalls,
      });
      tx.update(phoneRef, { available: true, borrowedBy: null });
      tx.update(agentRef, { activeBorrowUnit: null, activeRecordId: null });
    });
    return { success: true, message: "Phone returned successfully!" };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── RECORDS ──────────────────────────────────────────────────
async function getRecords(data) {
  const q = query(collection(db, "records"), orderBy("borrowTime", "asc"));
  const snap = await getDocs(q);
  let records = [];
  snap.forEach((d) => records.push(recordToHeaderObj(d.data())));

  if (data && data.unitNo)
    records = records.filter(
      (r) => r["Phone Unit"].toString().trim() === data.unitNo.toString().trim()
    );

  if (data && data.filter) {
    const now = new Date();
    let startDate;
    if (data.filter === "day") startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (data.filter === "week") { startDate = new Date(now); startDate.setDate(now.getDate() - 7); }
    if (data.filter === "month") startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    if (startDate)
      records = records.filter((r) => r["Borrow Time"] && new Date(r["Borrow Time"]) >= startDate);
  }
  return { success: true, records };
}

async function getUnreturnedUnits() {
  const q = query(collection(db, "records"), where("returnTime", "==", null));
  const snap = await getDocs(q);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const unreturned = [];
  snap.forEach((d) => {
    const v = d.data();
    const borrowTime = v.borrowTime ? v.borrowTime.toDate() : null;
    if (!borrowTime) return;
    const bd = new Date(borrowTime); bd.setHours(0, 0, 0, 0);
    unreturned.push({
      recordId: v.recordId,
      agentName: v.agentName,
      unitNo: v.unitNo,
      serialNo: v.serialNo,
      borrowTime: borrowTime.toISOString(),
      status: bd < today ? "Overdue" : "Active Today",
    });
  });
  return { success: true, unreturned };
}

async function verifyRecord(data) {
  const ref = doc(db, "records", data.recordId.toString());
  const snap = await getDoc(ref);
  if (!snap.exists()) return { success: false, message: "Record not found." };
  const v = snap.data();
  const agentCalls = parseInt(v.clientsCalledAgent) || 0;
  const agentSucc = parseInt(v.successfulCallsAgent) || 0;
  const adminCalls = parseInt(data.adminCalls);
  const adminSucc = parseInt(data.adminSuccessful);
  const status = agentCalls === adminCalls && agentSucc === adminSucc ? "Verified" : "Flagged";
  await updateDoc(ref, {
    clientsCalledAdmin: adminCalls,
    successfulCallsAdmin: adminSucc,
    verificationStatus: status,
  });
  return { success: true, status, message: "Record marked as " + status + "." };
}

// ── PIN (stored on the agent doc) ───────────────────────────
async function checkPin(data) {
  const snap = await getDoc(doc(db, "agents", slug(data.agentName)));
  if (!snap.exists()) return { success: true, hasPin: false };
  return { success: true, hasPin: !!snap.data().pin };
}

async function setPin(data) {
  const ref = doc(db, "agents", slug(data.agentName));
  const snap = await getDoc(ref);
  if (!snap.exists()) return { success: false, message: "Agent not found." };
  const hadPin = !!snap.data().pin;
  await updateDoc(ref, { pin: data.pin.toString() });
  return { success: true, message: hadPin ? "PIN updated." : "PIN set." };
}

async function verifyPin(data) {
  const snap = await getDoc(doc(db, "agents", slug(data.agentName)));
  if (!snap.exists() || !snap.data().pin)
    return { success: false, message: "PIN not set. Please create your PIN first." };
  if (snap.data().pin.toString() === data.pin.toString()) return { success: true };
  return { success: false, message: "Incorrect PIN. Please try again." };
}

async function resetPin(data) {
  const ref = doc(db, "agents", slug(data.agentName));
  const snap = await getDoc(ref);
  if (!snap.exists() || !snap.data().pin)
    return { success: false, message: "No PIN found for this agent." };
  await updateDoc(ref, { pin: "" });
  return { success: true, message: "PIN reset. Agent can set a new PIN on next login." };
}

// ── ADMIN LOGIN ──────────────────────────────────────────────
async function adminLogin(data) {
  const snap = await getDoc(doc(db, "admins", slug(data.username)));
  if (!snap.exists()) return { success: false, message: "Invalid username or password." };
  const v = snap.data();
  if (v.password.toString().trim() === data.password.trim())
    return { success: true, adminId: snap.id, username: v.username };
  return { success: false, message: "Invalid username or password." };
}

// ── DISPATCHER (same shape as the old Apps Script doPost) ──
export async function api(payload) {
  try {
    switch (payload.action) {
      case "getAgents":     return await getAgents();
      case "addAgent":      return await addAgent(payload);
      case "removeAgent":   return await removeAgent(payload);
      case "assignTeam":    return await assignTeam(payload);
      case "getTeams":      return await getTeams();
      case "addTeam":       return await addTeam(payload);
      case "removeTeam":    return await removeTeam(payload);
      case "getPhones":     return await getPhones();
      case "addPhone":      return await addPhone(payload);
      case "removePhone":   return await removePhone(payload);
      case "borrowPhone":   return await borrowPhone(payload);
      case "returnPhone":   return await returnPhone(payload);
      case "getRecords":    return await getRecords(payload);
      case "getUnreturned": return await getUnreturnedUnits();
      case "verifyRecord":  return await verifyRecord(payload);
      case "adminLogin":    return await adminLogin(payload);
      case "checkPin":      return await checkPin(payload);
      case "setPin":        return await setPin(payload);
      case "verifyPin":     return await verifyPin(payload);
      case "resetPin":      return await resetPin(payload);
      default: return { success: false, message: "Unknown action." };
    }
  } catch (err) {
    return { success: false, message: "Firestore error: " + err.message };
  }
}

// index.html / admin.html call the global `api(...)` function directly
// (they're classic, non-module scripts) — expose it on window.
window.api = api;
