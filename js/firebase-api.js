// ============================================================
// PHONE BORROWING SYSTEM — FIRESTORE BACKEND (client-side)
// Drop-in replacement for the old Apps Script `api(payload)`
// function. Same action names, same request/response shapes,
// so index.html / admin.html need almost no changes.
//
// Data model (Firestore collections):
//   agents/{slug(name)}   { name, team, pin, activeBorrowUnit, activeRecordId }
//   teams/{slug(teamName)}{ teamName, manager }
//   phones/{slug(unitNo)} { unitNo, serialNo, available, borrowedBy,
//                            pendingReturn, pendingRecordId,
//                            physicallyReturned, unavailableReason }
//   records/{recordId}    { recordId, agentName, unitNo, serialNo,
//                            borrowTime, returnTime, notes,
//                            clientsCalledAgent, successfulCallsAgent,
//                            clientsCalledAdmin, successfulCallsAdmin,
//                            verificationStatus, wasOverdue }
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

// Session time limit (hours) before an active/pending-return loan is
// flagged Overdue. Keep this in sync with OVERDUE_HOURS in index.html —
// there's no shared build step here, so it's duplicated by design.
const OVERDUE_HOURS = 2;

// Reasons an admin can hold a unit unavailable after (or instead of) a
// return. "Other" ships a free-text reason string from the admin UI.
const HOLD_REASONS = ["Not charged", "SIM restricted", "Under verification (previous borrower)", "Others"];

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
    "Overdue Return": v.wasOverdue === true,
  };
}

// ── AGENTS ──────────────────────────────────────────────────
async function getAgents() {
  const snap = await getDocs(collection(db, "agents"));
  const agents = [];
  snap.forEach((d) => {
    const v = d.data();
    agents.push({
      name: v.name,
      team: v.team || "",
      pinResetRequested: !!v.pinResetRequested,
      pinResetRequestedAt: toIso(v.pinResetRequestedAt),
    });
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
    email: data.email ? data.email.trim().toLowerCase() : "",
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
      borrowTime: toIso(v.borrowTime),
      pendingReturn: !!v.pendingReturn,
      pendingRecordId: v.pendingRecordId || null,
      physicallyReturned: !!v.physicallyReturned,
      unavailableReason: v.unavailableReason || null,
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
    borrowTime: null,
    pendingReturn: false,
    pendingRecordId: null,
    physicallyReturned: false,
    unavailableReason: null,
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
      if (a.activeBorrowUnit) {
        const heldRef = doc(db, "phones", slug(a.activeBorrowUnit));
        const heldSnap = await tx.get(heldRef);
        if (heldSnap.exists() && heldSnap.data().pendingReturn) {
          throw new Error(
            "Your return of Unit " + a.activeBorrowUnit + " is awaiting admin verification. You can't borrow another phone yet."
          );
        }
        throw new Error("You already have Unit " + a.activeBorrowUnit + " borrowed. Return it first.");
      }
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
        wasOverdue: false,
      });
      tx.update(phoneRef, {
        available: false,
        borrowedBy: data.agentName,
        borrowTime: Timestamp.now(),
        physicallyReturned: false,
      });
      tx.update(agentRef, { activeBorrowUnit: data.unitNo, activeRecordId: recordId });
    });
    return { success: true, message: "Phone borrowed successfully!" };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// Agent taps "Return Phone": this is a SOFT return. It logs their
// reported call counts, but does NOT free the unit, and does NOT clear
// the agent's own active session either — the agent stays locked out
// of borrowing another phone until an admin verifies the physical
// return via resolveReturn(). This exists because an agent can tap the
// button without actually handing the phone back.
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
      const r = recordSnap.data();

      // Was this unit held past the overdue threshold before the agent
      // tapped Return? Recorded permanently here so it still shows up
      // in this agent's history/performance after the loan is resolved
      // and the live "Unreturned Units" view no longer has it.
      const borrowMs = r.borrowTime ? r.borrowTime.toMillis() : null;
      const wasOverdue = borrowMs != null && (Date.now() - borrowMs) >= OVERDUE_HOURS * 3600000;

      tx.update(recordRef, {
        returnTime: Timestamp.now(),
        clientsCalledAgent: data.clientsCalled,
        successfulCallsAgent: data.successfulCalls,
        wasOverdue,
      });
      // available/borrowedBy/borrowTime, and the agent's
      // activeBorrowUnit/activeRecordId, are all left as-is on purpose —
      // resolveReturn() clears them once an admin confirms.
      tx.update(phoneRef, { pendingReturn: true, pendingRecordId: a.activeRecordId });
    });
    return {
      success: true,
      message: "Return submitted. You're locked out of borrowing until admin verifies this return.",
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// Admin confirms the PHONE ITSELF is physically back in hand — the
// unit is still out of rotation (not `available`) and still shows up
// in Pending Returns, awaiting the admin's call-count verification and
// final Release/Hold decision via resolveReturn(). What this DOES do
// is clear the agent's lock immediately, so they aren't stuck waiting
// on call verification before they can borrow a different unit. It's
// a distinct, optional step — admins can still jump straight to
// Release/Hold on resolveReturn() without ever calling this.
async function confirmPhysicalReturn(data) {
  const phoneRef = doc(db, "phones", slug(data.unitNo));
  try {
    await runTransaction(db, async (tx) => {
      const phoneSnap = await tx.get(phoneRef);
      if (!phoneSnap.exists()) throw new Error("Phone unit not found.");
      const p = phoneSnap.data();
      if (!p.pendingReturn || !p.pendingRecordId)
        throw new Error("This unit has no pending return to confirm.");
      if (p.physicallyReturned) throw new Error("Already confirmed physically back.");

      // All reads (including the agent lookup) must happen before any
      // writes in a Firestore transaction — get the agent doc now,
      // decide whether to unlock it, then do both writes together.
      let agentRef = null;
      let agentSnap = null;
      if (p.borrowedBy) {
        agentRef = doc(db, "agents", slug(p.borrowedBy));
        agentSnap = await tx.get(agentRef);
      }

      tx.update(phoneRef, { physicallyReturned: true });

      // Only unlock the agent if they haven't already moved on to a
      // newer active loan (which can happen since this unlocks them
      // before the final Release/Hold decision).
      if (agentRef && agentSnap && agentSnap.exists() && agentSnap.data().activeRecordId === p.pendingRecordId) {
        tx.update(agentRef, { activeBorrowUnit: null, activeRecordId: null });
      }
    });
    return {
      success: true,
      message: "Physical return confirmed — unit stays unavailable until verified and released.",
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// Admin confirms a physical return (or rejects it) after reviewing the
// agent's reported call counts against their own count. Either way,
// this is what clears the agent's lock — a Hold decision means the
// PHONE has a problem, not that the agent did anything wrong.
//   decision: "available"   → unit goes back into rotation
//   decision: "unavailable" → unit is held; `reason` is required and
//             should be one of HOLD_REASONS (or free text for "Others")
async function resolveReturn(data) {
  const phoneRef = doc(db, "phones", slug(data.unitNo));
  const decision = data.decision === "available" ? "available" : "unavailable";
  if (decision === "unavailable" && !data.reason)
    return { success: false, message: "A reason is required to hold this unit unavailable." };

  let verificationStatus = null;
  try {
    await runTransaction(db, async (tx) => {
      const phoneSnap = await tx.get(phoneRef);
      if (!phoneSnap.exists()) throw new Error("Phone unit not found.");
      const p = phoneSnap.data();
      if (!p.pendingReturn || !p.pendingRecordId)
        throw new Error("This unit has no pending return to verify.");

      const recordRef = doc(db, "records", p.pendingRecordId);
      const recordSnap = await tx.get(recordRef);
      if (!recordSnap.exists()) throw new Error("Return record not found.");
      const r = recordSnap.data();

      // The agent may still be resolvable via the phone's borrowedBy
      // field (it isn't cleared until this function runs).
      let agentRef = null;
      let agentSnap = null;
      if (p.borrowedBy) {
        agentRef = doc(db, "agents", slug(p.borrowedBy));
        agentSnap = await tx.get(agentRef);
      }

      const agentCalls = parseInt(r.clientsCalledAgent) || 0;
      const agentSucc = parseInt(r.successfulCallsAgent) || 0;
      const adminCalls = parseInt(data.adminCalls);
      const adminSucc = parseInt(data.adminSuccessful);
      verificationStatus = agentCalls === adminCalls && agentSucc === adminSucc ? "Verified" : "Flagged";

      tx.update(recordRef, {
        clientsCalledAdmin: adminCalls,
        successfulCallsAdmin: adminSucc,
        verificationStatus,
      });

      tx.update(phoneRef, {
        available: decision === "available",
        borrowedBy: null,
        borrowTime: null,
        pendingReturn: false,
        pendingRecordId: null,
        physicallyReturned: false,
        unavailableReason: decision === "available" ? null : data.reason.toString().trim(),
      });

      // Only clear the agent's active-loan lock if it still points at
      // THIS return — confirmPhysicalReturn() may already have
      // unlocked them onto a newer loan, which we must not stomp on.
      if (agentRef && agentSnap && agentSnap.exists() && agentSnap.data().activeRecordId === p.pendingRecordId) {
        tx.update(agentRef, { activeBorrowUnit: null, activeRecordId: null });
      }
    });
    return {
      success: true,
      status: verificationStatus,
      message: decision === "available" ? "Return verified — unit released and available." : "Return verified — unit held unavailable.",
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// Ad-hoc admin action: pull a unit out of rotation for one of the
// HOLD_REASONS without going through a borrow/return cycle. Refuses if
// the unit is actively out (still borrowed) or awaiting return
// verification — those go through resolveReturn instead.
async function setPhoneHold(data) {
  const ref = doc(db, "phones", slug(data.unitNo));
  const snap = await getDoc(ref);
  if (!snap.exists()) return { success: false, message: "Phone unit not found." };
  const p = snap.data();
  if (p.pendingReturn)
    return { success: false, message: "This unit has a pending return — verify it first." };
  if (p.borrowedBy)
    return { success: false, message: "This unit is currently borrowed." };
  if (!data.reason) return { success: false, message: "A reason is required." };
  await updateDoc(ref, { available: false, unavailableReason: data.reason.toString().trim() });
  return { success: true, message: "Unit marked unavailable." };
}

// Ad-hoc admin action: bring a held (non-borrowed) unit back into
// rotation.
async function setPhoneAvailable(data) {
  const ref = doc(db, "phones", slug(data.unitNo));
  const snap = await getDoc(ref);
  if (!snap.exists()) return { success: false, message: "Phone unit not found." };
  const p = snap.data();
  if (p.pendingReturn)
    return { success: false, message: "This unit has a pending return — verify it first." };
  if (p.borrowedBy)
    return { success: false, message: "This unit is currently borrowed." };
  await updateDoc(ref, { available: true, unavailableReason: null });
  return { success: true, message: "Unit marked available." };
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

// "Unreturned" now means: not yet physically confirmed back by an
// admin — this covers both units still with an agent AND units an
// agent has clicked Return on but that are awaiting admin verification
// (pendingReturn). Overdue uses the same OVERDUE_HOURS session limit
// the Agent Portal shows.
async function getUnreturnedUnits() {
  const snap = await getDocs(collection(db, "phones"));
  const unreturned = [];
  snap.forEach((d) => {
    const v = d.data();
    if (v.available !== false || !v.borrowTime) return; // no active loan clock
    if (v.physicallyReturned) return; // admin already confirmed it's back in hand — it now lives in Pending Returns, not here
    const borrowTime = v.borrowTime.toDate();
    const hrs = (Date.now() - borrowTime.getTime()) / 3600000;
    unreturned.push({
      unitNo: v.unitNo,
      serialNo: v.serialNo,
      agentName: v.borrowedBy || "—",
      borrowTime: borrowTime.toISOString(),
      pendingReturn: !!v.pendingReturn,
      status: hrs >= OVERDUE_HOURS ? "Overdue" : "Active",
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

// ── NOTIFICATION DISMISSALS ──────────────────────────────────
// Notifications themselves (PIN reset requests, pending returns) are
// derived live from the agents/phones collections — there's no separate
// "notifications" collection for those. Dismissing one just records that
// its key has been acknowledged, shared across every admin, in this small
// collection. The admin portal is responsible for deleting a dismissal once
// its underlying notification is no longer live (see the "clearDismissal"
// calls it fires), so this collection doesn't grow forever.
function notifDocId(key) {
  return key.toString().replace(/\//g, "_").slice(0, 400);
}

async function getDismissedNotifs() {
  const snap = await getDocs(collection(db, "notifDismissals"));
  const keys = [];
  snap.forEach((d) => keys.push(d.data().key || d.id));
  return { success: true, keys };
}

async function dismissNotif(data) {
  const key = (data.key || "").toString();
  if (!key) return { success: false, message: "Missing notification key." };
  await setDoc(doc(db, "notifDismissals", notifDocId(key)), {
    key,
    dismissedAt: Timestamp.now(),
    dismissedBy: data.dismissedBy || "",
  });
  return { success: true };
}

async function dismissAllNotifs(data) {
  const keys = Array.isArray(data.keys) ? data.keys : [];
  await Promise.all(
    keys.map((key) =>
      setDoc(doc(db, "notifDismissals", notifDocId(key)), {
        key,
        dismissedAt: Timestamp.now(),
        dismissedBy: data.dismissedBy || "",
      })
    )
  );
  return { success: true };
}

async function clearDismissal(data) {
  const key = (data.key || "").toString();
  if (!key) return { success: false, message: "Missing notification key." };
  await deleteDoc(doc(db, "notifDismissals", notifDocId(key)));
  return { success: true };
}

// Agent tapped "Forgot PIN?" on the login screen and gave their email.
// We flag their agent doc so it surfaces on the admin portal (badge +
// per-row indicator); no PIN is touched here — clearing it is still an
// admin-only action via resetPin.
async function requestPinReset(data) {
  const email = (data.email || "").trim().toLowerCase();
  if (!email) return { success: false, message: "Enter your email first, then tap Forgot PIN." };
  const q = query(collection(db, "agents"), where("email", "==", email));
  const snap = await getDocs(q);
  if (snap.empty) return { success: false, message: "No account found for that email." };
  await updateDoc(snap.docs[0].ref, {
    pinResetRequested: true,
    pinResetRequestedAt: Timestamp.now(),
  });
  return { success: true, message: "Request sent. An admin will reset your PIN shortly." };
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
  const newPin = (data.pin || "").toString();
  if (!/^[0-9]{6}$/.test(newPin))
    return { success: false, message: "PIN must be exactly 6 digits." };
  const hadPin = !!snap.data().pin;
  await updateDoc(ref, { pin: newPin, pinResetRequested: false, pinResetRequestedAt: null });
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
  await updateDoc(ref, { pin: "", pinResetRequested: false, pinResetRequestedAt: null });
  return { success: true, message: "PIN reset. Agent can set a new PIN on next login." };
}

// ── AGENT LOGIN (Agent Portal — email + PIN) ─────────────────
// NOTE: agents/{slug} docs need an "email" field added manually
// (or via the updated addAgent) alongside the existing "pin"
// field before an agent can log in here. Same plain-text trust
// level as before — this is an internal tool.
async function agentLogin(data) {
  const email = (data.email || "").trim().toLowerCase();
  const pin = (data.pin || "").toString();
  if (!email || !pin)
    return { success: false, message: "Email and PIN are required." };
  if (!/^[0-9]{6}$/.test(pin))
    return { success: false, message: "PIN must be exactly 6 digits." };
  const q = query(collection(db, "agents"), where("email", "==", email));
  const snap = await getDocs(q);
  if (snap.empty)
    return { success: false, message: "Invalid email or PIN." };
  const v = snap.docs[0].data();
  if (!v.pin)
    return {
      success: false,
      needsPinSetup: true,
      agentName: v.name,
      message: "No PIN set yet. Please create one to continue.",
    };
  if (v.pin.toString() !== pin)
    return { success: false, message: "Incorrect PIN. Please try again." };
  return {
    success: true,
    agent: {
      name: v.name,
      team: v.team || "",
      email: v.email || "",
      activeBorrowUnit: v.activeBorrowUnit || null,
      activeRecordId: v.activeRecordId || null,
    },
  };
}

// Used to restore a persisted session and to refresh the logged-in
// agent's active-borrow state after a borrow/return.
async function getAgent(data) {
  const snap = await getDoc(doc(db, "agents", slug(data.name)));
  if (!snap.exists()) return { success: false, message: "Agent not found." };
  const v = snap.data();
  return {
    success: true,
    agent: {
      name: v.name,
      team: v.team || "",
      email: v.email || "",
      activeBorrowUnit: v.activeBorrowUnit || null,
      activeRecordId: v.activeRecordId || null,
    },
  };
}

// Used by the Agent Portal to show borrow time / purpose for the
// agent's own active session (e.g. on the Return Device screen).
async function getRecord(data) {
  const ref = doc(db, "records", data.recordId.toString());
  const snap = await getDoc(ref);
  if (!snap.exists()) return { success: false, message: "Record not found." };
  return { success: true, record: recordToHeaderObj(snap.data()) };
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
      case "confirmPhysicalReturn": return await confirmPhysicalReturn(payload);
      case "resolveReturn": return await resolveReturn(payload);
      case "setPhoneHold":      return await setPhoneHold(payload);
      case "setPhoneAvailable": return await setPhoneAvailable(payload);
      case "getRecords":    return await getRecords(payload);
      case "getUnreturned": return await getUnreturnedUnits();
      case "verifyRecord":  return await verifyRecord(payload);
      case "adminLogin":    return await adminLogin(payload);
      case "agentLogin":    return await agentLogin(payload);
      case "getAgent":      return await getAgent(payload);
      case "getRecord":     return await getRecord(payload);
      case "checkPin":      return await checkPin(payload);
      case "setPin":        return await setPin(payload);
      case "verifyPin":     return await verifyPin(payload);
      case "resetPin":      return await resetPin(payload);
      case "requestPinReset": return await requestPinReset(payload);
      case "getDismissedNotifs": return await getDismissedNotifs();
      case "dismissNotif":      return await dismissNotif(payload);
      case "dismissAllNotifs":  return await dismissAllNotifs(payload);
      case "clearDismissal":    return await clearDismissal(payload);
      default: return { success: false, message: "Unknown action." };
    }
  } catch (err) {
    return { success: false, message: "Firestore error: " + err.message };
  }
}

// index.html / admin.html call the global `api(...)` function directly
// (they're classic, non-module scripts) — expose it on window.
window.api = api;
