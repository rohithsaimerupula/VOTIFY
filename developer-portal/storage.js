function getApiBase() {
    if (typeof API !== 'undefined' && API) return API;
    if (typeof PROD_API_URL !== 'undefined' && PROD_API_URL) return PROD_API_URL;
    if (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1') && location.port === '5500') {
        return 'http://localhost:3001/api';
    }
    return 'https://votify-backend-delta.vercel.app/api';
}

const _isCapacitorNative = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();

// Shared utilities
async function fetchApi(path, options = {}, retries = 2) {
    const apiBase = getApiBase();
    try {
        const currentUser = JSON.parse(localStorage.getItem('ovs_currentUser') || 'null');
        const inst = localStorage.getItem('ovs_inst_name') || (currentUser ? currentUser.institution : '');
        
        const res = await fetch(`${apiBase}${path}`, {
            ...(options || {}),
            headers: {
                'Content-Type': 'application/json',
                'X-OVS-Reg-Num': currentUser ? (currentUser.regNum || 'guest') : 'guest',
                'X-OVS-Institution': encodeURIComponent(inst || 'Unknown'),
                ...((options && options.headers) || {})
            }
        });
        if (!res.ok) {
            let err;
            try { err = await res.json(); } catch(e) { err = { error: res.statusText }; }
            const msg = (err && typeof err === 'object') ? (err.error || "API Request Failed") : "API Request Failed";
            throw new Error(msg);
        }
        return await res.json();
    } catch (e) {
        if (retries > 0 && e.message !== "Not found" && !e.message.includes("exists")) {
            console.warn(`[OVS Network] Fetch failed: ${e.message}. Retrying... (${retries} retries left)`);
            await new Promise(r => setTimeout(r, 600));
            return fetchApi(path, options, retries - 1);
        }
        throw e;
    }
}

const StorageManager = {
    saveSession(user) {
        localStorage.setItem('ovs_currentUser', JSON.stringify(user));
    },

    getCurrentUser() {
        const user = localStorage.getItem('ovs_currentUser');
        return user ? JSON.parse(user) : null;
    },

    logout() {
        this.logAudit("User logged out", this.getCurrentUser()?.regNum || "Unknown");
        localStorage.removeItem('ovs_currentUser');
    },

    async logAudit(action, userRegNum, details = "") {
        try {
            const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
            await fetchApi(`/auditLogs?institution=${encodeURIComponent(inst)}`, {
                method: 'POST',
                body: JSON.stringify({ action, user: userRegNum, details, timestamp: new Date().toISOString(), institution: inst })
            });
        } catch(e) { console.error("Audit Log Failure: ", e); }
    },

    async validateInstitution() {
        const inst = localStorage.getItem('ovs_inst_name');
        const code = localStorage.getItem('ovs_inst_code');
        if (!inst) return true; // Don't block if not configured
        try {
            const apiBase = getApiBase();
            let url = `${apiBase}/institutions/validate?name=${encodeURIComponent(inst)}`;
            if (code) url += `&code=${encodeURIComponent(code)}`;
            const res = await fetch(url);
            if (res.status === 404) {
                // Only wipe if server definitively says institution does not exist
                localStorage.removeItem('ovs_inst_name');
                localStorage.removeItem('ovs_inst_code');
                localStorage.removeItem('ovs_inst_logo');
                localStorage.removeItem('ovs_gate_unlocked');
                localStorage.removeItem('ovs_currentUser');
                return false;
            }
            return true;
        } catch (e) {
            console.warn("Institution validation failed (network glitch?):", e);
            return true; // Assume valid if network fails
        }
    },

    async getAuditLogs() {
        try {
            const currentUser = this.getCurrentUser();
            const inst = currentUser ? currentUser.institution : "";
            return await fetchApi(`/auditLogs?institution=${encodeURIComponent(inst)}`);
        } catch(e) { console.error(e); return []; }
    },

    async getDeviceFingerprint() {
        const screenRes = `${window.screen.width}x${window.screen.height}`;
        const colorDepth = window.screen.colorDepth;
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const language = navigator.language;
        const userAgent = navigator.userAgent;
        const rawString = `${screenRes}|${colorDepth}|${timezone}|${language}|${userAgent}`;
        
        let hash = 0;
        for (let i = 0; i < rawString.length; i++) {
            const char = rawString.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; 
        }
        return `FP-${Math.abs(hash).toString(16).toUpperCase()}`;
    },

    async checkAndLogFingerprint(action, regNum) {
        const fp = await this.getDeviceFingerprint();
        
        try {
            let fpData;
            try {
                fpData = await fetchApi(`/deviceFingerprints/${fp}`);
            } catch (e) {
                fpData = null; // not found
            }

            if (fpData) {
                const counts = fpData.counts || {};
                
                if (!counts[regNum]) counts[regNum] = { registrations: 0, votes: 0 };

                if (action === 'register') {
                    counts[regNum].registrations++;
                    if (Object.keys(counts).length > 3) {
                         this.logAudit("Multiple Accounts Flag", regNum, `Device Fingerprint ${fp} has ${Object.keys(counts).length} users.`);
                    }
                } else if (action === 'vote') {
                    counts[regNum].votes++;
                     if (Object.keys(counts).length > 5) {
                         this.logAudit("Multiple Votes Flag", regNum, `Device Fingerprint ${fp} used for ${Object.keys(counts).length} votes.`);
                    }
                }
                await fetchApi('/deviceFingerprints', {
                    method: 'POST',
                    body: JSON.stringify({ fingerprint: fp, firstSeen: fpData.firstSeen, lastActive: new Date().toISOString(), counts })
                });
            } else {
                const counts = {};
                counts[regNum] = { registrations: action === 'register' ? 1 : 0, votes: action === 'vote' ? 1 : 0 };
                await fetchApi('/deviceFingerprints', {
                    method: 'POST',
                    body: JSON.stringify({ fingerprint: fp, firstSeen: new Date().toISOString(), lastActive: new Date().toISOString(), counts })
                });
            }
            return fp;
        } catch (e) {
            console.error("Fingerprint Error:", e);
            return fp;
        }
    },

    async hashPassword(password) {
        if (!password) return "";
        try {
            // SubtleCrypto requires a secure context (HTTPS or localhost)
            if (!window.crypto || !window.crypto.subtle) {
                console.warn("[OVS Security] crypto.subtle unavailable. Falling back to btoa.");
                return btoa(password);
            }
            const msgUint8 = new TextEncoder().encode(password);
            const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            console.error("[OVS Security] Hashing failed:", e);
            return btoa(password); // Final fallback
        }
    },

    // --- OFFLINE/FIRESTORE IMAGE COMPRESSION ---
    async compressImage(base64Str, maxWidth = 350, maxHeight = 350, quality = 0.3) {
        if (!base64Str || typeof base64Str !== 'string' || !base64Str.startsWith('data:image')) return base64Str; 
        try {
            return await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > maxWidth) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    }
                } else {
                    if (height > maxHeight) {
                        width = Math.round((width * maxHeight) / height);
                        height = maxHeight;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                const compressedString = canvas.toDataURL('image/jpeg', quality);
                resolve(compressedString);
            };
            img.onerror = () => {
                console.warn("StorageManager: Image compression failed, using original.");
                resolve(base64Str);
            };
            img.src = base64Str;
            });
        } catch (e) {
            console.warn("StorageManager.compressImage failed:", e);
            return base64Str;
        }
    },

    // --- REGISTRATION ---
    async addUser(user) {
        if (user.password) {
            user.password = await this.hashPassword(user.password);
        }
        
        // All registrations now go to pending for Class Admin approval
        user.status = 'pending';
        if (user.aiVerified === true) {
            this.logAudit("AI Verified Registration (Pending Approval)", user.regNum);
        }
        delete user.aiVerified; // Clean up before POST
        user.hasVoted = false;
        user.isBanned = false;

        if (user.portrait) user.portrait = await this.compressImage(user.portrait, 400, 400, 0.4);
        if (user.webcamReg) user.webcamReg = await this.compressImage(user.webcamReg, 400, 400, 0.4);
        
        try {
            // Check if user exists
            let existingUser;
            try {
                existingUser = await fetchApi(`/users/${user.regNum}?institution=${encodeURIComponent(user.institution)}`);
            } catch (e) { existingUser = null; }

            if (existingUser) {
                if (existingUser.isBanned || existingUser.isBanned === 1) {
                    throw new Error("This Registration Number is permanently BANNED at this institution.");
                }
                throw new Error("Registration Number already exists at this institution.");
            }

            const fp = await this.checkAndLogFingerprint('register', user.regNum);
            user.deviceFingerprint = fp;

            const inst = user.institution || 'Unknown';
            await fetchApi(`/users/add?institution=${encodeURIComponent(inst)}`, {
                method: 'POST',
                body: JSON.stringify(user)
            });
            return true;
        } catch (error) {
            console.error("Add User Error: ", error);
            throw new Error(error.message);
        }
    },

    async updateUser(user) {
        if (!user || !user.regNum) throw new Error("Invalid user data for update.");
        const inst = user.institution || 'Unknown';
        
        // Log the audit
        this.logAudit("User updated profile", user.regNum);
        
        try {
            await fetchApi(`/users/${user.regNum}?institution=${encodeURIComponent(inst)}`, {
                method: 'PATCH',
                body: JSON.stringify(user)
            });
            return true;
        } catch (error) {
            console.error("Update User Error: ", error);
            throw new Error(error.message);
        }
    },

    // --- LOGIN ---
    async login(regNum, password, skip2FA = false) {
        try {
            const inst = localStorage.getItem('ovs_inst_name');
            let userData;
            try {
                const apiPath = inst ? `/users/${regNum}?institution=${encodeURIComponent(inst)}` : `/users/${regNum}`;
                userData = await fetchApi(apiPath);
            } catch (e) {
                if (e.message === "Not found") {
                    throw new Error("Your details are not found in our records for this college. Please check your ID or Register first.");
                }
                throw new Error("Backend connection failed: " + e.message);
            }

            if (!userData) throw new Error("Could not retrieve user data.");

            if (userData.isBanned || userData.isBanned === 1) throw new Error("This account has been banned by the Administrator.");
            
            if (userData.status === 'pending') {
                throw new Error("Your registration is pending approval by your Class Admin. You cannot login until they accept your request.");
            }

            const activeInst = localStorage.getItem('ovs_inst_name');
            if (userData.role !== 'developer' && activeInst && userData.institution !== activeInst) {
                if (userData.institution && userData.institution !== 'Unknown') {
                    throw new Error("User does not belong to this Institution.");
                }
            }

            const hashedPwd = await this.hashPassword(password);
            const legacyHashed = btoa(password); 
            const isMatch = (
                userData.password === hashedPwd || 
                userData.password === legacyHashed || 
                userData.password === password
            );

            if (!isMatch) throw new Error("Invalid credentials.");

            if (userData.hasVoted === 1) userData.hasVoted = true;
            if (userData.hasVoted === 0) userData.hasVoted = false;
            if (userData.canVote === 1) userData.canVote = true;
            if (userData.canVote === 0) userData.canVote = false;
            if (userData.isBanned === 1) userData.isBanned = true;
            if (userData.isBanned === 0) userData.isBanned = false;
            
            this.saveSession(userData);
            this.logAudit(`${(userData.role || "unknown").toUpperCase()} Login Success`, regNum);
            return userData;
        } catch (error) {
            console.error("Login Error: ", error);
            throw new Error(error.message);
        }
    },

    // --- CLASS ADMIN STUDENT ENROLLMENT WITH FALLBACK ---
    async enrollClassStudent(studentData) {
        const inst = localStorage.getItem('ovs_inst_name');
        try {
            return await fetchApi('/subadmin/enroll-student', {
                method: 'POST',
                body: JSON.stringify({ ...studentData, institution: inst })
            });
        } catch (error) {
            console.warn("Primary enroll endpoint failed, attempting fallback:", error.message);
            // Seamless fallback to standard /users endpoint
            const payload = {
                ...studentData,
                role: 'voter',
                status: 'approved',
                institution: inst,
                faceDescriptor: typeof studentData.faceDescriptor === 'object' ? JSON.stringify(studentData.faceDescriptor) : studentData.faceDescriptor,
                createdAt: new Date().toISOString()
            };
            return await fetchApi('/users', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        }
    },

    // --- CLASS ADMIN UPDATE STUDENT (NAME, REGNUM, BIOMETRICS) WITH FALLBACK ---
    async updateClassStudent(updateData) {
        const inst = localStorage.getItem('ovs_inst_name');
        try {
            return await fetchApi('/subadmin/update-student', {
                method: 'POST',
                body: JSON.stringify({ ...updateData, institution: inst })
            });
        } catch (error) {
            console.warn("Primary update endpoint failed, attempting fallback:", error.message);
            const targetOldReg = updateData.oldRegNum;
            const patchPayload = {
                name: updateData.name,
                regNum: updateData.newRegNum || updateData.oldRegNum,
                portrait: updateData.portrait,
                webcamReg: updateData.webcamReg
            };
            if (updateData.faceDescriptor) {
                patchPayload.faceDescriptor = typeof updateData.faceDescriptor === 'object' ? JSON.stringify(updateData.faceDescriptor) : updateData.faceDescriptor;
            }
            return await fetchApi(`/users/${encodeURIComponent(targetOldReg)}?institution=${encodeURIComponent(inst)}`, {
                method: 'PATCH',
                body: JSON.stringify(patchPayload)
            });
        }
    },

    // --- VOTER LOOKUP FOR FACE LOGIN WITH FALLBACK ---
    async lookupStudentForLogin(regNum) {
        const inst = localStorage.getItem('ovs_inst_name');
        try {
            const res = await fetchApi('/auth/voter-lookup', {
                method: 'POST',
                body: JSON.stringify({ regNum, institution: inst })
            });
            return res.student;
        } catch (error) {
            console.warn("Primary voter lookup failed, attempting fallback query:", error.message);
            const targetReg = (regNum || '').trim().toUpperCase();
            // Fallback: Query /users/:id or /users list
            let student = null;
            try {
                student = await fetchApi(`/users/${encodeURIComponent(targetReg)}?institution=${encodeURIComponent(inst)}`);
            } catch(e) {
                const allUsers = await fetchApi(`/users?institution=${encodeURIComponent(inst)}`);
                student = (allUsers || []).find(u => (u.regNum || '').toUpperCase() === targetReg);
            }

            if (!student) {
                throw new Error(`Student with Registration ID "${targetReg}" not found in ${inst || 'this institution'}. Please contact your Class Admin to enroll.`);
            }

            if (student.role !== 'voter' && student.role !== 'candidate') {
                throw new Error(`Account "${targetReg}" is registered as staff (${student.role}). Please use the Staff Login portal.`);
            }

            if (student.status === 'banned') {
                throw new Error("This student account is suspended. Please contact the administrator.");
            }

            let descriptor = null;
            if (student.faceDescriptor) {
                try {
                    descriptor = typeof student.faceDescriptor === 'string' ? JSON.parse(student.faceDescriptor) : student.faceDescriptor;
                } catch(e) { descriptor = null; }
            }

            return {
                regNum: student.regNum,
                name: student.name,
                role: student.role,
                branch: student.branch,
                year: student.year,
                class: student.class || student.section,
                institution: student.institution,
                portrait: student.portrait,
                webcamReg: student.webcamReg,
                faceDescriptor: descriptor,
                status: student.status,
                hasPassword: !!(student.password && student.password.trim() !== '')
            };
        }
    },

    // --- STUDENT PROFILE UPDATE (EMAIL, PHONE, PASSWORD) WITH FALLBACK ---
    async updateStudentProfile(profileData) {
        const inst = localStorage.getItem('ovs_inst_name');
        try {
            const res = await fetchApi('/student/update-profile', {
                method: 'POST',
                body: JSON.stringify({ ...profileData, institution: inst })
            });
            const current = this.getCurrentUser();
            if (current && current.regNum === profileData.regNum) {
                if (profileData.email) current.email = profileData.email;
                if (profileData.phone) current.phone = profileData.phone;
                current.hasPassword = true;
                this.saveSession(current);
            }
            return res;
        } catch (error) {
            console.warn("Primary profile update failed, attempting fallback:", error.message);
            const patchPayload = {};
            if (profileData.email) patchPayload.email = profileData.email;
            if (profileData.phone) patchPayload.phone = profileData.phone;
            if (profileData.newPassword) {
                patchPayload.password = await this.hashPassword(profileData.newPassword);
            }
            const res = await fetchApi(`/users/${encodeURIComponent(profileData.regNum)}?institution=${encodeURIComponent(inst)}`, {
                method: 'PATCH',
                body: JSON.stringify(patchPayload)
            });
            const current = this.getCurrentUser();
            if (current && current.regNum === profileData.regNum) {
                if (profileData.email) current.email = profileData.email;
                if (profileData.phone) current.phone = profileData.phone;
                current.hasPassword = true;
                this.saveSession(current);
            }
            return { success: true, message: "Profile updated successfully." };
        }
    },

    async resetPassword(regNum, newPassword, institution) {
        const inst = institution || localStorage.getItem('ovs_inst_name') || 'Unknown';
        const hashedPwd = await this.hashPassword(newPassword);
        await fetchApi(`/users/${regNum}?institution=${encodeURIComponent(inst)}`, {
            method: 'PATCH',
            body: JSON.stringify({ password: hashedPwd })
        });
        return true;
    },

    async updateUserDetails(regNum, updates) {
        if (updates.password) {
            updates.password = await this.hashPassword(updates.password);
        }
        const inst = updates.institution || (this.getCurrentUser()?.institution) || 'Unknown';
        await fetchApi(`/users/${regNum}?institution=${encodeURIComponent(inst)}`, {
            method: 'PATCH',
            body: JSON.stringify(updates)
        });
        const current = this.getCurrentUser();
        if (current && current.regNum === regNum) {
            this.saveSession({ ...current, ...updates });
        }
        this.logAudit("Profile Updated", regNum);
        return true;
    },

    async sendResetOtp(regNum, institution) {
        console.log(`[StorageManager] Attempting password reset for: ${regNum} @ ${institution}`);
        const inst = institution || localStorage.getItem('ovs_inst_name') || 'Unknown';
        let userData;
        try { userData = await fetchApi(`/users/${regNum}?institution=${encodeURIComponent(inst)}`); } catch(e) { }
        
        if (!userData) {
            console.warn(`[StorageManager] Reset failed: User ID ${regNum} not found in institution ${inst}.`);
            return { success: false, error: `ID "${regNum}" is not registered in this institution.` };
        }

        if (!userData.email) {
            console.warn(`[StorageManager] Reset failed: User ${regNum} has no email.`);
            return { success: false, error: "Account exists but has no recovery email registered." };
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const maskedEmail = userData.email.replace(/^(.{2})(.*)(@.*)$/, "$1***$3");
        
        await this.sendEmailOtp(userData.email, userData.name, otp, "Password Reset Request");
        return { 
            success: true, 
            otp: otp, 
            maskedEmail: maskedEmail
        };
    },

    async sendEmailOtp(email, name, otp, context) {
         console.log(`[EmailSystem] Sending ${context} OTP Request to Backend: ${email}`);
         return await fetchApi('/auth/send-otp', {
             method: 'POST',
             body: JSON.stringify({
                 email: email,
                 name: name,
                 otp: otp,
                 context: context
             })
         }, 0);
    },

    // --- VOTING ---
    async getElectionStatus() {
        try {
            const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
            return await fetchApi(`/config/election_${inst}`);
        } catch (e) {
            // If completely missing, we assume not started
            return { isActive: false, isCompleted: false, startTime: null, endTime: null };
        }
    },
    async getRegistrationStatus() {
        try {
            const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
            return await fetchApi(`/config/registration_${inst}`);
        } catch (e) {
            // For a new institution, if no config exists, we default to OPEN to allow the first users/admins to register.
            return { isActive: true, isCompleted: false, startTime: null, endTime: null };
        }
    },
    async getInstitutionConfig(key) {
        try {
            const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
            return await fetchApi(`/config/${key}_${inst}`);
        } catch (e) { return null; }
    },
    async setElectionTimes(startTime, endTime) {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi(`/config/election_${inst}`, {
            method: 'POST',
            body: JSON.stringify({ merge: true, data: { startTime, endTime } })
        });
    },
    async pauseElection(diff) {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi(`/config/election_${inst}`, {
            method: 'POST',
            body: JSON.stringify({ merge: true, data: { isActive: false, frozenRemaining: diff } })
        });
    },
    async resumeElection() {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi(`/config/election_${inst}`, {
            method: 'POST',
            body: JSON.stringify({ merge: true, data: { isActive: true, frozenRemaining: null } })
        });
    },
    async setElectionCompletion(isCompleted) {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi(`/config/election_${inst}`, {
            method: 'POST',
            body: JSON.stringify({ merge: true, data: { isCompleted: isCompleted, isActive: false } })
        });
    },
    async resetElection() {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi('/election/reset', { 
            method: 'POST',
            body: JSON.stringify({ institution: inst })
        });
    },
    async getCandidates() {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        return await fetchApi(`/candidates?institution=${encodeURIComponent(inst)}`);
    },
    async fetchMyElections(regNum, institution) {
        try {
            return await fetchApi(`/voters/my-elections?regNum=${encodeURIComponent(regNum)}&institution=${encodeURIComponent(institution)}`);
        } catch (e) { return []; }
    },
    async generateVoteHash(voterRegNum, candidateRegNum, electionCode) {
        const cStr = typeof candidateRegNum === 'object' ? JSON.stringify(candidateRegNum) : candidateRegNum;
        const str = voterRegNum + cStr + (electionCode||'') + Date.now().toString() + Math.random().toString();
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; 
        }
        return "VOTE-RECEIPT-" + Math.abs(hash).toString(16).toUpperCase() + "-" + Date.now().toString().slice(-4);
    },
    async vote(voterRegNum, candidateRegNum, webcamPhoto, electionCode) {
        const finalVotePhoto = webcamPhoto ? await this.compressImage(webcamPhoto, 400, 400, 0.4) : null;
        const secureHash = await this.generateVoteHash(voterRegNum, candidateRegNum, electionCode);
        const fp = await this.checkAndLogFingerprint('vote', voterRegNum);
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';

        const res = await fetchApi('/vote', {
            method: 'POST',
            body: JSON.stringify({
                voterRegNum, candidateRegNum, votePhoto: finalVotePhoto,
                secureHash, fp, institution: inst, electionCode, timestamp: new Date().toISOString()
            })
        });

        const receiptMatch = res.receipt || secureHash;

        let voterData = await fetchApi(`/users/${voterRegNum}?institution=${encodeURIComponent(inst)}`);
        // We no longer locally lock out the whole account by blindly setting hasVoted=true in storage if they play in multi-tiers.
        // Wait, 'hasVoted' is still returned by backend `api/users` as 1. So it acts as a legacy lock if needed.
        this.saveSession({ ...voterData, voteReceiptHash: receiptMatch });
        this.logAudit("Vote Cast (Pending)", voterRegNum, `Receipt: ${receiptMatch} | Election: ${electionCode||'global'}`);
        return receiptMatch;
    },

    async fetchElectionResults(electionId) {
        try {
            return await fetchApi(`/elections/${encodeURIComponent(electionId)}/results`);
        } catch (e) {
            console.error("Results Error:", e);
            return { success: false, results: [] };
        }
    },

    _processStatsSnapshot(users) {
        let stats = {
            totalVoters: 0, totalContestants: 0, votesCast: 0, votesPending: 0, votesNotCast: 0,
            voters: [], contestants: [], candidateVotes: {}
        };
        users.forEach(user => {
            if (user.hasVoted === 1) user.hasVoted = true;
            if (user.hasVoted === 0) user.hasVoted = false;
            if (user.role === 'voter') {
                stats.totalVoters++;
                stats.voters.push(user);
                if (user.hasVoted) {
                    if (user.voteStatus === 'pending') stats.votesPending++;
                    else {
                        stats.votesCast++;
                        if (user.votedFor) {
                            try {
                                const votedObj = JSON.parse(user.votedFor);
                                if (typeof votedObj === 'object') {
                                    Object.values(votedObj).forEach(candRegNum => {
                                        if (!stats.candidateVotes[candRegNum]) stats.candidateVotes[candRegNum] = 0;
                                        stats.candidateVotes[candRegNum]++;
                                    });
                                } else {
                                    if (!stats.candidateVotes[user.votedFor]) stats.candidateVotes[user.votedFor] = 0;
                                    stats.candidateVotes[user.votedFor]++;
                                }
                            } catch(e) {
                                if (!stats.candidateVotes[user.votedFor]) stats.candidateVotes[user.votedFor] = 0;
                                stats.candidateVotes[user.votedFor]++;
                            }
                        }
                    }
                } else stats.votesNotCast++;
            } else if (user.role === 'contestant') {
                stats.totalContestants++;
                stats.contestants.push(user);
                if (!stats.candidateVotes[user.regNum]) stats.candidateVotes[user.regNum] = 0;
            }
        });
        return stats;
    },

    listenToStats(callback) {
        let lastDataStr = "";
        const activeInst = localStorage.getItem('ovs_inst_name');
        const poll = async () => {
            try {
                if (!activeInst) return;
                const users = await fetchApi(`/users?institution=${encodeURIComponent(activeInst)}`);
                const stats = this._processStatsSnapshot(users);
                const newDataStr = JSON.stringify(stats);
                if (newDataStr !== lastDataStr) {
                    lastDataStr = newDataStr;
                    callback(stats);
                }
            } catch (e) { console.error("Stats poll error:", e); }
        };
        poll();
        const interval = setInterval(poll, 3000);
        return () => clearInterval(interval);
    },

    listenToElection(callback) {
        let lastDataStr = "";
        const poll = async () => {
            try {
                const doc = await this.getElectionStatus();
                const newDataStr = JSON.stringify(doc);
                if (newDataStr !== lastDataStr) {
                    lastDataStr = newDataStr;
                    callback(doc);
                }
            } catch (e) { callback({ isActive: false, isCompleted: false, startTime: null, endTime: null }); }
        };
        poll();
        const interval = setInterval(poll, 3000);
        return () => clearInterval(interval);
    },

    // --- Q&A BOARD ---
    async submitQuestion(candidateRegNum, voterName, questionText) {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi(`/questions?institution=${encodeURIComponent(inst)}`, { 
            method: 'POST', 
            body: JSON.stringify({ candidateId: candidateRegNum, voterName, question: questionText, timestamp: new Date().toISOString(), institution: inst }) 
        });
    },
    async getQuestions(candidateRegNum) { 
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        return await fetchApi(`/questions/${candidateRegNum}?institution=${encodeURIComponent(inst)}`); 
    },
    async answerQuestion(questionId, answerText) { 
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi(`/questions/${questionId}?institution=${encodeURIComponent(inst)}`, { 
            method: 'PATCH', 
            body: JSON.stringify({ answer: answerText }) 
        }); 
    },

    // --- ADMIN ACTIONS ---
    async updateAdminId(oldRegNum, newRegNum) {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        let oldDoc = await fetchApi(`/users/${oldRegNum}?institution=${encodeURIComponent(inst)}`);
        oldDoc.regNum = newRegNum;
        await fetchApi(`/users/add?institution=${encodeURIComponent(inst)}`, { method: 'POST', body: JSON.stringify(oldDoc) });
        await fetchApi(`/users/${oldRegNum}?institution=${encodeURIComponent(inst)}`, { method: 'DELETE' });
        await this.logAudit("Changed Admin ID", oldRegNum, `New ID: ${newRegNum}`);
    },

    async getUsers() { 
        const inst = localStorage.getItem('ovs_inst_name');
        if (!inst) return [];
        return await fetchApi(`/users?institution=${encodeURIComponent(inst)}`); 
    },
    async clearUsersByRole(role) { 
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi(`/users/role/${role}?institution=${encodeURIComponent(inst)}`, { method: 'DELETE' }); 
    },
    async getAnnouncement() { 
        try { 
            const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
            const doc = await fetchApi(`/config/announcement_${inst}`); 
            return doc.message; 
        } catch(e) { return null; } 
    },
    async setAnnouncement(msg) { 
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi(`/config/announcement_${inst}`, { method: 'POST', body: JSON.stringify({ merge: false, data: { message: msg } }) }); 
    },
    async approveUser(regNum) {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi(`/users/${regNum}?institution=${encodeURIComponent(inst)}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) });
        this.logAudit("Approved User", regNum);
    },
    async rejectUser(regNum, reason) {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi(`/users/${regNum}?institution=${encodeURIComponent(inst)}`, { method: 'DELETE' });
        this.logAudit("Rejected User", regNum, reason);
    },
    async deleteUser(regNum) {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi(`/users/${regNum}?institution=${encodeURIComponent(inst)}`, { method: 'DELETE' });
        this.logAudit("Deleted User Account", regNum);
    },
    async banUser(regNum) {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi(`/users/${regNum}?institution=${encodeURIComponent(inst)}`, { method: 'PATCH', body: JSON.stringify({ isBanned: 1 }) });
        this.logAudit("Banned User", regNum);
    },
    async unbanUser(regNum) {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi(`/users/${regNum}?institution=${encodeURIComponent(inst)}`, { method: 'PATCH', body: JSON.stringify({ isBanned: 0 }) });
        this.logAudit("Unbanned User", regNum);
    },
    async verifyVote(regNum, isValid) {
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        if (isValid) await fetchApi(`/users/${regNum}?institution=${encodeURIComponent(inst)}`, { method: 'PATCH', body: JSON.stringify({ voteStatus: 'verified', status: 'active' }) });
        else await fetchApi(`/users/${regNum}?institution=${encodeURIComponent(inst)}`, { method: 'PATCH', body: JSON.stringify({ hasVoted: 0, votedFor: null, voteStatus: null, status: 'active' }) });
    },

    // --- GLOBAL CHAT ---
    async getGlobalMessages() { 
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        const messages = await fetchApi(`/globalChat?institution=${encodeURIComponent(inst)}`); 
        return messages; 
    },
    async sendGlobalMessage(voterName, messageText) { 
        const inst = localStorage.getItem('ovs_inst_name') || 'Unknown';
        await fetchApi('/globalChat', { method: 'POST', body: JSON.stringify({ voterName, text: messageText, timestamp: new Date().toISOString(), institution: inst }) }); 
    },
    listenToGlobalChat(callback) {
        let lastDataStr = "";
        const poll = async () => {
            try {
                const messages = await this.getGlobalMessages();
                const newDataStr = JSON.stringify(messages);
                if (newDataStr !== lastDataStr) { lastDataStr = newDataStr; callback(messages.reverse()); }
            } catch (e) { }
        };
        poll();
        const interval = setInterval(poll, 3000);
        return () => clearInterval(interval);
    },
    
    // --- SYSTEM HEALTH ---
    async fetchSystemHealth() {
        try {
            const inst = localStorage.getItem('ovs_inst_name') || 'Global';
            return await fetchApi(`/admin/system-health?institution=${encodeURIComponent(inst)}`);
        } catch (e) {
            console.error("Health Fetch Error:", e);
            throw e;
        }
    },

    async validateInstitution() {
        const inst = localStorage.getItem('ovs_inst_name');
        if (!inst) return false;
        try {
            const res = await fetchApi(`/institutions/validate?name=${encodeURIComponent(inst)}`);
            return res.success === true;
        } catch (e) {
            return false;
        }
    },

    async verifyCurrentSession() {
        const user = this.getCurrentUser();
        const inst = localStorage.getItem('ovs_inst_name');

        // Security Policy: If we are in a tenant-specific context (non-developer), 
        // we must verify that the institution is still active and the code hasn't changed.
        if (user && user.role !== 'developer' && inst) {
            try {
                const res = await fetchApi(`/institutions/validate?name=${encodeURIComponent(inst)}`);
                if (res.success !== true) throw new Error("Invalid");
            } catch (e) {
                // ONLY logout if the error is an explicit 401 Unauthorized or 403 Forbidden
                // (which fetchApi should bubble up as an error with that status/message)
                const errorText = e.message ? e.message.toLowerCase() : "";
                if (errorText.includes("no longer active") || errorText.includes("removed or changed") || errorText.includes("401") || errorText.includes("403")) {
                    console.warn("[OVS Security] Institution validation failed explicitly. Invalidating session.");
                    this.logout();
                    localStorage.removeItem('ovs_inst_name');
                    localStorage.removeItem('ovs_gate_unlocked');
                    alert('Session Invalid: This institution is no longer active or the access code has changed.');
                    window.location.href = 'index.html';
                    return false;
                }
                // For transient network errors (e.g. 500, 503, or failed to fetch), we keep the session.
                console.warn("[OVS Security] Transient validation error, keeping session:", e.message);
            }
        }

        if (!user) return true;
        try {
            // Check without inst if developer, else with inst
            const apiPath = (user.role === 'developer' || !inst) ? `/users/${encodeURIComponent(user.regNum)}` : `/users/${encodeURIComponent(user.regNum)}?institution=${encodeURIComponent(inst)}`;
            const latestUser = await fetchApi(apiPath);
            
            // If password has changed remotely, force logout
            if (latestUser.password !== user.password) {
                console.warn("[OVS Security] Remote password change detected. Session invalidated.");
                this.logout();
                window.location.href = 'index.html'; // Force redirect to gateway
                return false;
            }
            // Sync any other role/status updates silently
            if (JSON.stringify(latestUser) !== JSON.stringify(user)) {
                console.log("[OVS Security] Session data updated from server.");
                this.saveSession(latestUser);
                window.dispatchEvent(new CustomEvent('ovs_session_updated', { detail: latestUser }));
            }
            return true;
        } catch (e) {
            if (e.message && e.message.toLowerCase().includes("not found")) {
                 console.warn("[OVS Security] User account no longer exists. Session invalidated.");
                 this.logout();
                 window.location.href = 'index.html';
                 return false;
            }
            return true;
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname.toLowerCase();
    let themeClass = 'theme-home';
    if (path.includes('login')) themeClass = 'theme-login';
    else if (path.includes('register')) themeClass = 'theme-register';
    else if (path.includes('voter_dashboard')) themeClass = 'theme-voter';
    else if (path.includes('admin_dashboard')) themeClass = 'theme-admin';
    document.body.classList.add(themeClass);
    
    // Asynchronously verify session integrity globally and periodically
    setTimeout(() => { 
        StorageManager.verifyCurrentSession(); 
        setInterval(() => StorageManager.verifyCurrentSession(), 30000);
    }, 100);

    // Register PWA Service Worker
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./service-worker.js')
                .then(registration => {
                    console.log('ServiceWorker registration successful with scope: ', registration.scope);
                })
                .catch(err => {
                    console.log('ServiceWorker registration failed: ', err);
                });
        });
    }
});

