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
      restrictedBy: v.restrictedBy || "",
      offenseLevel: v.offenseLevel || 0,
      restricted: !!v.restricted,
      restrictionReason: v.restrictionReason || "",
      restrictedAt: toIso(v.restrictedAt),
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
      if (a.restricted)
        throw new Error("Your account is restricted. Please speak with your manager or an admin.");
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

// ── AGENT MONITORING, OFFENSES & RESTRICTIONS ──────────────
// Detection is automatic (the admin page creates flags); enforcement is
// manual: flags never change an agent's offense level or restriction on
// their own. Collections:
//   monitorConfig/settings  thresholds (see MON_DEFAULTS)
//   flags/{id}              { type: overdue|calls|rate, agentName, status: pending|confirmed|dismissed, ... }
//   auditLog/{id}           one entry per admin action
//   clarifications/{id}     manager-clarification requests
//   offenses/{id}           one record per offense, linked to its flag + source borrowing record; incidentAt = original event time,
//                           at = when the admin assigned it; status active|superseded (never deleted)
//   restrictions/{id}       one record per restriction (applied / removed)
//   counters/flags, counters/histFlags   running numbers for FLAG #0001 / HIST-001 ids
// Flag.source: AUTOMATIC (live detection) | HISTORICAL (backfilled from pre-existing borrowing records) | MANUAL.
// Backfill is additive: it only creates pending flags (dated from the original record) and never touches records, offenses or restrictions.
//   agents/{slug}           + offenseLevel (0-3), restricted, restrictionReason, restrictedAt/By
// Enforcement actions need admins/{user}.canEnforce !== false (default allowed;
// set canEnforce:false on an admin doc to make them view/review-only).
const MON_DEFAULTS = { minCalls: 10, minSuccessRate: 50, periodDays: 7, overdueThresholds: [1, 2, 3], trackingStart: "" };
const CLAR_STATUSES = ["Pending Clarification", "Clarification Received", "Verified", "Rejected", "Restriction Approved", "Restriction Cancelled"];
const CLAR_OPEN = ["Pending Clarification", "Clarification Received", "Verified", "Restriction Approved"];

// Structured violation reason. One borrowing session (sourceRecordId) can carry one flag PER reason.
const FLAG_REASONS = { CALL_LOG_VERIFICATION: "Call Log / Verification", OVERDUE_RETURN: "Overdue Return" };
const REASON_OF_TYPE = { overdue: "OVERDUE_RETURN", mismatch: "CALL_LOG_VERIFICATION", calls: "CALL_LOG_VERIFICATION", rate: "CALL_LOG_VERIFICATION" };
const reasonOf = (f) => f.flagReason || REASON_OF_TYPE[f.type] || null;

const guard = (fn) => async (d) => {
  try { return await fn(d || {}); } catch (e) { return { success: false, message: e.message }; }
};
const need = (v, msg) => { if (v == null || !v.toString().trim()) throw new Error(msg); return v.toString().trim(); };
function tsToIso(o) { for (const k in o) if (o[k] && o[k].toDate) o[k] = o[k].toDate().toISOString(); return o; }
const listAll = async (c) => (await getDocs(collection(db, c))).docs.map((d) => tsToIso(d.data()));

async function assertEnforcer(user) {
  need(user, "Admin not identified — sign in again.");
  const s = await getDoc(doc(db, "admins", slug(user)));
  if (!s.exists() || s.data().canEnforce === false)
    throw new Error("Your admin account can't impose offenses or restrictions.");
}
async function writeAudit(e) {
  const id = "AUD-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  const base = { id, at: Timestamp.now(), agentName: null, violationType: null, flagId: null, decision: null, admin: null,
    prevLevel: null, newLevel: null, reason: "", notes: "", restrictionStatus: null, clarificationStatus: null };
  await setDoc(doc(db, "auditLog", id), { ...base, ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) });
}

const getMonitoring = guard(async () => {
  const cref = doc(db, "monitorConfig", "settings");
  let cs = await getDoc(cref);
  if (!cs.exists()) { // first run: start tracking today so old history doesn't flood the queue
    await setDoc(cref, { ...MON_DEFAULTS, trackingStart: new Date().toISOString().slice(0, 10) });
    cs = await getDoc(cref);
  }
  const [flags, audit, clarifications, offenses, restrictions] = await Promise.all([listAll("flags"), listAll("auditLog"), listAll("clarifications"), listAll("offenses"), listAll("restrictions")]);
  return { success: true, config: { ...MON_DEFAULTS, ...cs.data() }, flags, audit, clarifications, offenses, restrictions };
});

const saveMonitorConfig = guard(async (d) => {
  await assertEnforcer(d.admin);
  const n = (v, min, max, label) => {
    const x = Number(v);
    if (!Number.isFinite(x) || x < min || x > max) throw new Error(label + " must be between " + min + " and " + max + ".");
    return x;
  };
  const t = (d.overdueThresholds || []).map(Number);
  if (t.length !== 3 || t.some((x, i) => !(x >= 1) || (i && x < t[i - 1])))
    throw new Error("Overdue thresholds must be three non-decreasing numbers, each at least 1.");
  const cfg = {
    minCalls: n(d.minCalls, 0, 1000, "Minimum calls"),
    minSuccessRate: n(d.minSuccessRate, 0, 100, "Minimum success rate"),
    periodDays: n(d.periodDays, 1, 90, "Activity period"),
    overdueThresholds: t,
    trackingStart: d.trackingStart || "",
  };
  await setDoc(doc(db, "monitorConfig", "settings"), cfg);
  await writeAudit({ violationType: "settings", decision: "Settings changed", admin: d.admin, notes: JSON.stringify(cfg) });
  return { success: true, message: "Settings saved." };
});

// Flag ids are deterministic (per record / per agent+period), and a flag is
// only ever created if it doesn't exist — so re-running detection never
// resets a flag an admin already reviewed.
const syncFlags = guard(async (d) => {
  const list = d.flags || [];
  if (list.some((f) => f.source === "HISTORICAL")) await assertEnforcer(d.admin); // backfill is an admin action
  let created = 0, skipped = 0;
  // A session may have several flags, but only one per reason: sourceRecordId + flagReason is unique.
  const seen = new Set((await listAll("flags")).filter((x) => x.sourceRecordId || x.recordId).map((x) => (x.sourceRecordId || x.recordId) + "|" + reasonOf(x)));
  for (const f of list) {
    const ref = doc(db, "flags", f.id), hist = f.source === "HISTORICAL";
    const fReason = f.flagReason || REASON_OF_TYPE[f.type] || null, ukey = f.recordId ? f.recordId + "|" + fReason : null;
    if (ukey && seen.has(ukey)) { const ex = await getDoc(ref); if (!ex.exists()) { skipped++; continue; } }
    await runTransaction(db, async (tx) => {
      const cref = doc(db, "counters", hist ? "histFlags" : "flags");
      const fs = await tx.get(ref), cs = await tx.get(cref);
      if (fs.exists()) { skipped++; return; } // never overwrite a flag that already exists
      const flagNo = (cs.exists() ? cs.data().n : 0) + 1;
      tx.set(cref, { n: flagNo });
      if (ukey) seen.add(ukey);
      tx.set(ref, { ...f, flagReason: fReason, flagNo, flagRef: hist ? "HIST-" + String(flagNo).padStart(3, "0") : String(flagNo).padStart(4, "0"),
        source: f.source || "AUTOMATIC", sourceRecordId: f.recordId || null,
        status: "pending", createdAt: Timestamp.now(), reviewedBy: null, reviewedAt: null, offenseLevel: null, reason: "", notes: "" });
      created++;
    });
  }
  return { success: true, created, skipped };
});

// Adds the structured flagReason to flags created before it existed. Additive; touches nothing else.
const stampFlagReasons = guard(async () => {
  let updated = 0;
  for (const f of await listAll("flags")) if (!f.flagReason && REASON_OF_TYPE[f.type]) { await updateDoc(doc(db, "flags", f.id), { flagReason: REASON_OF_TYPE[f.type] }); updated++; }
  return { success: true, updated };
});

const logBackfill = guard(async (d) => {
  await assertEnforcer(d.admin);
  await writeAudit({ violationType: "migration", decision: "Historical backfill", admin: d.admin, notes: JSON.stringify(d.summary || {}) });
  return { success: true };
});

const reviewFlag = guard(async (d) => {
  const ref = doc(db, "flags", need(d.flagId, "Missing flag."));
  const s = await getDoc(ref);
  if (!s.exists()) throw new Error("Flag not found.");
  const f = s.data();
  if (f.status !== "pending") throw new Error("This flag was already reviewed.");
  const dismiss = d.decision === "dismiss";
  if (dismiss) need(d.reason, "Add a reason for dismissing this flag.");
  await updateDoc(ref, { status: dismiss ? "dismissed" : "confirmed", reviewedBy: d.admin || "", reviewedAt: Timestamp.now(), reason: d.reason || "", notes: d.notes || "" });
  await writeAudit({ agentName: f.agentName, violationType: f.type, flagReason: reasonOf(f), flagId: f.id, decision: dismiss ? "Flag dismissed" : "Flag confirmed", admin: d.admin, reason: d.reason, notes: d.notes });
  return { success: true, message: dismiss ? "Flag dismissed — no offense." : "Flag confirmed. Impose an offense if it's warranted." };
});

// ── OFFENSE RECORDS ─────────────────────────────────────────
// One record per offense, permanently linked to the flag (and through it, the original borrowing
// record) that caused it. agents/{slug}.offenseLevel is only a cache: it is always recomputed as the
// highest ACTIVE offense record. A record is never deleted — reassigning/withdrawing marks it
// status:"superseded" (who/when/why) and, if reassigned, creates a new linked record.
const ORD_API = ["", "1st", "2nd", "3rd"];
const isActiveOff = (o) => o.status !== "superseded";
// Offenses are counted SEPARATELY per violation type (Overdue Return vs Call Log / Verification):
// each type has its own 1st / 2nd / 3rd. agents/{slug}.offenseLevel caches the highest level across types.
const offReasonOf = (o) => o.flagReason || REASON_OF_TYPE[o.violationType] || null;
// "Legacy" levels: the agent doc claims them but no offense record exists (imposed before records were kept).
// Their violation type is unknown, so they block that level in every type.
const legacyLevels = (all, cached) => { const have = new Set(all.map((o) => o.level)), t = []; for (let k = 1; k <= cached; k++) if (!have.has(k)) t.push(k); return t; };
// Levels that can't be handed out again FOR THIS VIOLATION TYPE.
function takenLevels(all, cached, excludeId, reason) {
  return [...all.filter((o) => isActiveOff(o) && o.id !== excludeId && offReasonOf(o) === reason).map((o) => o.level), ...legacyLevels(all, cached)];
}
// Highest active level across ALL types (what the agent-level cache stores).
const overallLevel = (all, cached, excludeId, extra) => Math.max(0, extra || 0, ...all.filter((o) => isActiveOff(o) && o.id !== excludeId).map((o) => o.level), ...legacyLevels(all, cached));
const nextFree = (taken) => [1, 2, 3].find((k) => !taken.includes(k)) || 0;
const incidentLabel = (fd) => (fd.data && fd.data.Unit ? "Unit " + fd.data.Unit : fd.detail || fd.type || "");

const imposeOffense = guard(async (d) => {
  await assertEnforcer(d.admin);
  if (!d.flagId) throw new Error("Select the specific flag this offense applies to — offenses can't be created without a linked flag.");
  const reason = need(d.reason, "A reason is required to assign an offense."); let flagReason = d.flagReason || null;
  if (flagReason && !FLAG_REASONS[flagReason]) throw new Error("Unknown violation type.");
  const agentName = need(d.agentName, "Missing agent.");
  const aref = doc(db, "agents", slug(agentName));
  const fref = d.flagId ? doc(db, "flags", d.flagId) : null;
  const level = Number(d.level), oid = "OFF-" + Date.now();
  if (!(level >= 1 && level <= 3)) throw new Error("Choose the 1st, 2nd or 3rd offense.");
  const all = (await listAll("offenses")).filter((o) => o.agentName === agentName);
  let prev, fd = {}, wasPending = false;
  await runTransaction(db, async (tx) => {
    const a = await tx.get(aref);
    const f = fref ? await tx.get(fref) : null;
    if (!a.exists()) throw new Error("Agent not found.");
    prev = a.data().offenseLevel || 0;
    if (fref) {
      if (!f.exists()) throw new Error("Flag not found.");
      fd = f.data();
      if (fd.agentName !== agentName) throw new Error("That flag belongs to a different agent.");
      if (fd.status === "dismissed") throw new Error("This flag was dismissed.");
      if (fd.offenseLevel) throw new Error("This flag already has an offense. Use Reassign Offense to change it.");
      wasPending = fd.status === "pending";
      const fr = reasonOf(fd);
      if (fr && flagReason && fr !== flagReason) throw new Error("This flag is " + FLAG_REASONS[fr] + ", not " + FLAG_REASONS[flagReason] + ". The offense reason must match the flag.");
      flagReason = fr || flagReason;
    }
    if (!flagReason) throw new Error("Choose the violation type (Call Log / Verification or Overdue Return).");
    const taken = takenLevels(all, prev, null, flagReason), typeName = FLAG_REASONS[flagReason];
    if (taken.includes(level)) throw new Error("The " + ORD_API[level] + " " + typeName + " offense is already assigned. Use Reassign Offense on that flag to move it.");
    if (level !== nextFree(taken) && !d.override) throw new Error("Offenses are counted per violation type. The next " + typeName + " offense is the " + ORD_API[nextFree(taken)] + ". Use the sequence override to skip a level.");
    if (fref) {
      tx.update(fref, { status: "confirmed", flagReason: flagReason || null, offenseLevel: level, offenseId: oid,
        ...(wasPending ? { reviewedBy: d.admin, reviewedAt: Timestamp.now() } : {}) });
    }
    tx.set(doc(db, "offenses", oid), { id: oid, status: "active", agentName, agentId: slug(agentName), level, offenseNumber: level, prevLevel: prev, flagReason,
      flagId: d.flagId || null, flagNo: fd.flagNo || null, flagRef: fd.flagRef || null,
      sourceRecordId: fd.sourceRecordId || fd.recordId || null,
      incidentAt: fd.occurredAt || fd.createdAt || null,   // WHEN THE INCIDENT HAPPENED (original event)
      incidentLabel: fref ? incidentLabel(fd) : "",
      violationType: d.violationType || fd.type || "manual", flagDetail: fd.detail || "", flagData: fd.data || null, decision: "Offense imposed",
      reason, notes: d.notes || "", admin: d.admin, at: Timestamp.now(),   // WHEN THE ADMIN ASSIGNED IT
      override: level !== nextFree(taken), previousOffenseId: null });
    tx.update(aref, { offenseLevel: Math.max(prev, level) });
  });
  const ev = { agentName, flagReason, violationType: d.violationType || fd.type || "manual", flagId: d.flagId || null, flagRef: fd.flagRef || null,
    incidentAt: fd.occurredAt || fd.createdAt || null, incidentLabel: fref ? incidentLabel(fd) : "", offenseId: oid, admin: d.admin };
  if (wasPending) await writeAudit({ ...ev, decision: "Flag confirmed", reason, notes: d.notes });
  await writeAudit({ ...ev, decision: "Offense imposed", prevLevel: prev, newLevel: level, reason, notes: d.notes });
  return { success: true, message: ORD_API[level] + " offense assigned." };
});

// Move a flag's offense to another number, or withdraw it (level 0). The original assignment stays
// in the audit trail (status "superseded"). Never automatic.
const reassignOffense = guard(async (d) => {
  await assertEnforcer(d.admin);
  const reason = need(d.reason, "A reason is required to change an offense.");
  const agentName = need(d.agentName, "Missing agent.");
  const level = Number(d.level || 0);
  if (!(level >= 0 && level <= 3)) throw new Error("Choose No Offense, 1st, 2nd or 3rd.");
  const aref = doc(db, "agents", slug(agentName)), fref = doc(db, "flags", need(d.flagId, "Missing flag."));
  const all = (await listAll("offenses")).filter((o) => o.agentName === agentName);
  const oid = "OFF-" + Date.now();
  let fd, cur, newLevel;
  await runTransaction(db, async (tx) => {
    const a = await tx.get(aref), f = await tx.get(fref);
    if (!a.exists()) throw new Error("Agent not found.");
    if (!f.exists()) throw new Error("Flag not found.");
    fd = f.data();
    cur = all.find((o) => isActiveOff(o) && (o.id === fd.offenseId || o.flagId === d.flagId));
    if (!cur) throw new Error("This flag has no offense to reassign — assign one instead.");
    const ocur = await tx.get(doc(db, "offenses", cur.id));
    if (!ocur.exists() || ocur.data().status === "superseded") throw new Error("This offense changed in the meantime — refresh and try again.");
    if (level === cur.level) throw new Error("That is already this flag's offense.");
    const cached = a.data().offenseLevel || 0;
    const reasonKey = reasonOf(fd), typeName = FLAG_REASONS[reasonKey] || "this violation type";
    const taken = takenLevels(all, cached, cur.id, reasonKey);
    if (level > 0) {
      if (taken.includes(level)) throw new Error("The " + ORD_API[level] + " " + typeName + " offense is already assigned to another flag.");
      if (level !== nextFree(taken) && !d.override) throw new Error("Offenses are counted per violation type. The next " + typeName + " offense is the " + ORD_API[nextFree(taken)] + ". Use the sequence override to skip a level.");
    }
    newLevel = overallLevel(all, cached, cur.id, level);
    if (a.data().restricted && newLevel < 3) throw new Error("This agent is restricted. Remove the restriction before lowering the offense level.");
    tx.update(doc(db, "offenses", cur.id), { status: "superseded", supersededAt: Timestamp.now(), supersededBy: d.admin,
      supersededReason: reason, supersededNotes: d.notes || "", replacedById: level ? oid : null, replacedByLevel: level });
    if (level) tx.set(doc(db, "offenses", oid), { id: oid, status: "active", agentName, agentId: slug(agentName), level, offenseNumber: level, prevLevel: cur.level, flagReason: reasonOf(fd),
      flagId: d.flagId, flagNo: fd.flagNo || null, flagRef: fd.flagRef || null, sourceRecordId: fd.sourceRecordId || fd.recordId || null,
      incidentAt: fd.occurredAt || fd.createdAt || null, incidentLabel: incidentLabel(fd),
      violationType: fd.type || "manual", flagDetail: fd.detail || "", flagData: fd.data || null, decision: "Offense reassigned",
      reason, notes: d.notes || "", admin: d.admin, at: Timestamp.now(), override: level !== nextFree(taken), previousOffenseId: cur.id, previousLevel: cur.level });
    tx.update(fref, { offenseLevel: level || null, offenseId: level ? oid : null });
    tx.update(aref, { offenseLevel: newLevel });
  });
  await writeAudit({ agentName, violationType: fd.type || "manual", flagReason: reasonOf(fd), flagId: d.flagId, flagRef: fd.flagRef || null,
    incidentAt: fd.occurredAt || fd.createdAt || null, incidentLabel: incidentLabel(fd), offenseId: level ? oid : cur.id, previousOffenseId: cur.id,
    decision: level ? "Offense reassigned" : "Offense withdrawn", admin: d.admin, prevLevel: cur.level, newLevel: level, reason, notes: d.notes });
  return { success: true, message: level ? "Offense reassigned: " + ORD_API[cur.level] + " → " + ORD_API[level] + "." : "Offense withdrawn from this flag." };
});

const requestClarification = guard(async (d) => {
  await assertEnforcer(d.admin);
  const reason = need(d.reason, "A reason is required.");
  const as = await getDoc(doc(db, "agents", slug(need(d.agentName, "Missing agent."))));
  if (!as.exists()) throw new Error("Agent not found.");
  if ((as.data().offenseLevel || 0) < 3) throw new Error("Clarification applies once the 3rd offense is confirmed.");
  if ((await listAll("clarifications")).some((c) => c.agentName === d.agentName && CLAR_OPEN.includes(c.status)))
    throw new Error("This agent already has an open clarification request.");
  const team = as.data().team ? await getDoc(doc(db, "teams", slug(as.data().team))) : null;
  const id = "CLR-" + Date.now();
  await setDoc(doc(db, "clarifications", id), { id, agentName: d.agentName, manager: team && team.exists() ? team.data().manager || "" : "",
    reason, requestedAt: Timestamp.now(), requestedBy: d.admin, status: "Pending Clarification", notes: d.notes || "" });
  await writeAudit({ agentName: d.agentName, violationType: "restriction", decision: "Manager clarification requested", admin: d.admin,
    reason, notes: d.notes, clarificationStatus: "Pending Clarification" });
  return { success: true, message: "Clarification requested from the agent's manager." };
});

const updateClarification = guard(async (d) => {
  await assertEnforcer(d.admin);
  if (!CLAR_STATUSES.includes(d.status)) throw new Error("Unknown status.");
  const ref = doc(db, "clarifications", need(d.id, "Missing clarification."));
  const s = await getDoc(ref);
  if (!s.exists()) throw new Error("Clarification not found.");
  await updateDoc(ref, { status: d.status, notes: d.notes || s.data().notes || "", updatedBy: d.admin, updatedAt: Timestamp.now() });
  await writeAudit({ agentName: s.data().agentName, violationType: "restriction", decision: "Clarification status: " + d.status, admin: d.admin,
    reason: d.reason, notes: d.notes, clarificationStatus: d.status });
  return { success: true, message: "Clarification marked " + d.status + "." };
});

async function latestClarification(agentName) {
  return (await listAll("clarifications")).filter((c) => c.agentName === agentName)
    .sort((a, b) => (b.requestedAt || "").localeCompare(a.requestedAt || ""))[0];
}

const restrictAgent = guard(async (d) => {
  await assertEnforcer(d.admin);
  const reason = need(d.reason, "A reason is required to restrict an agent.");
  const ref = doc(db, "agents", slug(need(d.agentName, "Missing agent.")));
  const s = await getDoc(ref);
  if (!s.exists()) throw new Error("Agent not found.");
  if ((s.data().offenseLevel || 0) < 3) throw new Error("An agent needs a confirmed 3rd offense before restriction.");
  if (s.data().restricted) throw new Error("Agent is already restricted.");
  const c = await latestClarification(d.agentName);
  if (!c || !["Clarification Received", "Verified", "Restriction Approved"].includes(c.status))
    throw new Error("Request manager clarification and record the outcome (Received or Verified) before restricting.");
  const lastO = (await listAll("offenses")).filter((o) => o.agentName === d.agentName && o.level === 3 && isActiveOff(o)).sort((x, y) => (y.at || "").localeCompare(x.at || ""))[0];
  const rid = "RST-" + Date.now();
  await setDoc(doc(db, "restrictions", rid), { id: rid, agentName: d.agentName, at: Timestamp.now(), by: d.admin, reason, active: true,
    offenseId: lastO ? lastO.id : null, clarificationId: c.id, removedAt: null, removedBy: null, removeReason: "" });
  await updateDoc(ref, { restricted: true, restrictionReason: reason, restrictedAt: Timestamp.now(), restrictedBy: d.admin, restrictionId: rid });
  await updateDoc(doc(db, "clarifications", c.id), { status: "Restriction Approved", updatedBy: d.admin, updatedAt: Timestamp.now() });
  await writeAudit({ agentName: d.agentName, violationType: "restriction", decision: "Agent restricted", admin: d.admin, reason, notes: d.notes,
    prevLevel: 3, newLevel: 3, restrictionStatus: "Restricted", clarificationStatus: "Restriction Approved" });
  return { success: true, message: d.agentName + " is now restricted." };
});

const removeRestriction = guard(async (d) => {
  await assertEnforcer(d.admin);
  const reason = need(d.reason, "A reason is required to remove a restriction.");
  const ref = doc(db, "agents", slug(need(d.agentName, "Missing agent.")));
  const s = await getDoc(ref);
  if (!s.exists() || !s.data().restricted) throw new Error("Agent isn't restricted.");
  await updateDoc(ref, { restricted: false });
  if (s.data().restrictionId) await updateDoc(doc(db, "restrictions", s.data().restrictionId), { active: false, removedAt: Timestamp.now(), removedBy: d.admin, removeReason: reason });
  const c = await latestClarification(d.agentName);
  if (c && c.status === "Restriction Approved")
    await updateDoc(doc(db, "clarifications", c.id), { status: "Restriction Cancelled", updatedBy: d.admin, updatedAt: Timestamp.now() });
  await writeAudit({ agentName: d.agentName, violationType: "restriction", decision: "Restriction removed", admin: d.admin, reason, notes: d.notes,
    restrictionStatus: "Not restricted", clarificationStatus: c ? "Restriction Cancelled" : null });
  return { success: true, message: "Restriction removed." };
});

const addAdminNote = guard(async (d) => {
  const notes = need(d.notes, "Write a note first.");
  await writeAudit({ agentName: need(d.agentName, "Missing agent."), violationType: "note", decision: "Admin note", admin: d.admin, notes });
  return { success: true, message: "Note saved." };
});

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
      case "getMonitoring": return await getMonitoring(payload);
      case "saveMonitorConfig": return await saveMonitorConfig(payload);
      case "syncFlags": return await syncFlags(payload);
      case "stampFlagReasons": return await stampFlagReasons(payload);
      case "logBackfill": return await logBackfill(payload);
      case "reviewFlag": return await reviewFlag(payload);
      case "imposeOffense": return await imposeOffense(payload);
      case "reassignOffense": return await reassignOffense(payload);
      case "requestClarification": return await requestClarification(payload);
      case "updateClarification": return await updateClarification(payload);
      case "restrictAgent": return await restrictAgent(payload);
      case "removeRestriction": return await removeRestriction(payload);
      case "addAdminNote": return await addAdminNote(payload);
      default: return { success: false, message: "Unknown action." };
    }
  } catch (err) {
    return { success: false, message: "Firestore error: " + err.message };
  }
}

// index.html / admin.html call the global `api(...)` function directly
// (they're classic, non-module scripts) — expose it on window.
window.api = api;
