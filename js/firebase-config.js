// ============================================================
// FIREBASE CONFIG
// Paste the config object from: Firebase Console → Project
// Settings → General → "Your apps" → SDK setup and config.
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCnB-SwJzaEI-bUxqHcoHTV-EH7A70dzyA",
  authDomain: "phone-borrowing-system.firebaseapp.com",
  projectId: "phone-borrowing-system",
  storageBucket: "phone-borrowing-system.firebasestorage.app",
  messagingSenderId: "952755154089",
  appId: "1:952755154089:web:ec9055678eb2fcdc558db8"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
