import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail, reauthenticateWithCredential, EmailAuthProvider } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc, writeBatch, getDoc, setDoc, query, where, getDocs, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { subjectTree, flattenTreeWithObjects } from './assuntos.js';

const flatSubjects = flattenTreeWithObjects(subjectTree);

// Variáveis Globais
let db, auth, allAssisted = [], currentPautaId = null, unsubscribeFromAttendances = () => {}, currentUserName = '', currentPautaOwnerId = null, isPautaClosed = false;
let currentPautaData = null;
let assistedIdToHandle = null;
let colaboradores = [];
let editCollaboratorId = null;
let unsubscribeFromCollaborators = () => {};

// Elementos do DOM
const loadingContainer = document.getElementById('loading-container');
const loginContainer = document.getElementById('login-container');
const pautaSelectionContainer = document.getElementById('pautaSelection-container');
const appContainer = document.getElementById('app-container');

// Funções Utilitárias
const normalizeText = (str) => str ? str.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : '';
const getPriorityClass = (priority) => ({'URGENTE':'priority-urgente','Máxima':'priority-maxima','Média':'priority-media','Mínima':'priority-minima'}[priority]||'');
const getUpdatePayload = (data) => ({ ...data, lastActionBy: currentUserName, lastActionTimestamp: new Date().toISOString() });

const showNotification = (message, type = 'success') => {
    const colors = { info: 'blue', error: 'red', success: 'green' };
    const notification = document.createElement('div');
    notification.className = `fixed top-5 right-5 bg-${colors[type]}-500 text-white py-3 px-6 rounded-lg shadow-lg z-[100] transition-transform transform translate-x-full`;
    notification.textContent = message;
    document.body.appendChild(notification);
    requestAnimationFrame(() => notification.classList.remove('translate-x-full'));
    setTimeout(() => {
        notification.classList.add('translate-x-full');
        notification.addEventListener('transitionend', () => notification.remove());
    }, 3000);
};

const showScreen = (screenName) => {
    ['loading', 'login', 'pautaSelection', 'app'].forEach(id => {
        const container = document.getElementById(`${id}-container`);
        if (container) {
            container.classList.toggle('hidden', id !== screenName);
        } else {
            console.error(`Container not found: #${id}-container`);
        }
    });
};

// Lógica Principal da Aplicação
const getPriorityLevel = (assisted) => {
    if (!assisted || assisted.status !== 'aguardando') return 'N/A';
    if (assisted.priority === 'URGENTE') return 'URGENTE';
    if (assisted.type === 'avulso' || !assisted.scheduledTime || !assisted.arrivalTime) return 'Média';
    
    const scheduled = new Date(`1970-01-01T${assisted.scheduledTime}`);
    const arrival = new Date(assisted.arrivalTime);
    const arrivalTime = new Date(`1970-01-01T${arrival.toTimeString().slice(0, 5)}`);
    const diffMinutes = (arrivalTime - scheduled) / (1000 * 60);

    if (diffMinutes <= 0) return 'Máxima';
    if (diffMinutes <= 20) return 'Média';
    return 'Mínima';
};

const renderAssistedList = () => {
    allAssisted.forEach(a => {
        if (a.status === 'aguardando' && a.priority !== 'URGENTE') a.priority = getPriorityLevel(a);
    });

    const lists = {
        pauta: document.getElementById('pauta-list'),
        aguardando: document.getElementById('aguardando-list'),
        emAtendimento: document.getElementById('em-atendimento-list'),
        finalizado: document.getElementById('finalizados-list'),
        faltoso: document.getElementById('faltosos-list')
    };
    Object.values(lists).forEach(el => { if(el) el.innerHTML = ''; });

    const currentMode = document.getElementById('tab-agendamento').classList.contains('tab-active') ? 'agendamento' : 'avulso';
    const searchTerms = {
        pauta: normalizeText(document.getElementById('pauta-search').value),
        aguardando: normalizeText(document.getElementById('aguardando-search').value),
        emAtendimento: normalizeText(document.getElementById('em-atendimento-search').value),
        finalizado: normalizeText(document.getElementById('finalizados-search').value),
        faltoso: normalizeText(document.getElementById('faltosos-search').value)
    };
    const searchFilter = (a, term) => !term || ['name', 'cpf', 'subject'].some(key => normalizeText(a[key]).includes(term));

    const filtered = {
        pauta: allAssisted.filter(a => a.status === 'pauta' && a.type === 'agendamento' && searchFilter(a, searchTerms.pauta)),
        aguardando: allAssisted.filter(a => a.status === 'aguardando' && a.type === currentMode && searchFilter(a, searchTerms.aguardando)),
        emAtendimento: allAssisted.filter(a => a.status === 'em-atendimento' && a.type === currentMode && searchFilter(a, searchTerms.emAtendimento)),
        finalizado: allAssisted.filter(a => a.status === 'atendido' && a.type === currentMode && searchFilter(a, searchTerms.finalizado)),
        faltoso: allAssisted.filter(a => a.status === 'faltoso' && a.type === 'agendamento' && searchFilter(a, searchTerms.faltoso))
    };

    filtered.pauta.sort((a, b) => (a.scheduledTime || '23:59').localeCompare(b.scheduledTime || '23:59'));
    filtered.finalizado.sort((a, b) => new Date(b.attendedTime) - new Date(a.attendedTime));
    filtered.faltoso.sort((a, b) => (a.scheduledTime || '00:00').localeCompare(b.scheduledTime || '00:00'));

    filtered.aguardando.sort((a, b) => {
        if (a.priority === 'URGENTE' && b.priority !== 'URGENTE') return -1;
        if (b.priority === 'URGENTE' && a.priority !== 'URGENTE') return 1;
        if (a.priority === 'URGENTE' && b.priority === 'URGENTE') return (new Date(a.arrivalTime) - new Date(b.arrivalTime));
        const pautaOrder = currentPautaData?.ordemAtendimento || 'padrao';
        if (pautaOrder === 'chegada') {
            return (new Date(a.arrivalTime) - new Date(b.arrivalTime)) || (a.createdAt || 0) - (b.createdAt || 0);
        } else {
            const order = { 'Máxima': 1, 'Média': 2, 'Mínima': 3 };
            const priorityDiff = order[a.priority] - order[b.priority];
            if (priorityDiff !== 0) return priorityDiff;
            if (a.priority === 'Máxima') return (a.scheduledTime || '23:59').localeCompare(b.scheduledTime || '23:59');
            return (new Date(a.arrivalTime) - new Date(b.arrivalTime)) || (a.createdAt || 0) - (b.createdAt || 0);
        }
    });

    document.getElementById('pauta-count').textContent = filtered.pauta.length;
    document.getElementById('aguardando-count').textContent = filtered.aguardando.length;
    document.getElementById('em-atendimento-count').textContent = filtered.emAtendimento.length;
    document.getElementById('finalizados-count').textContent = filtered.finalizado.length;
    document.getElementById('faltosos-count').textContent = filtered.faltoso.length;

    const render = (el, data, generator) => {
        if (!el) return;
        el.innerHTML = data.length === 0 ? `<p class="text-gray-500 text-center p-4">Nenhum registro.</p>` : '';
        data.forEach((item, index) => el.appendChild(generator(item, index)));
    };

    render(lists.pauta, filtered.pauta, a => {
        const card = document.createElement('div');
        card.className = 'relative bg-gray-50 p-4 rounded-lg shadow-sm border';
        card.innerHTML = `
            <button data-id="${a.id}" class="delete-btn absolute top-2 right-2 text-gray-400 hover:text-red-600 p-1 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" class="pointer-events-none" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M11 1.5v1h3.5a.5.5 0 0 1 0 1h-.538l-.853 10.66A2 2 0 0 1 11.115 16h-6.23a2 2 0 0 1-1.994-1.84L2.038 3.5H1.5a.5.5 0 0 1 0-1H5v-1A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5zM4.5 5.029l.5 8.5a.5.5 0 1 0 .998-.06l-.5-8.5a.5.5 0 1 0-.998.06zm3 0l.5 8.5a.5.5 0 1 0 .998-.06l-.5-8.5a.5.5 0 1 0-.998.06zm3 .5a.5.5 0 0 0-1 0v8.5a.5.5 0 0 0 1 0v-8.5z"/></svg></button>
            <p class="font-bold text-lg">${a.name}</p>
            <p>Assunto: <strong>${a.subject}</strong></p>
            <p>Agendado: <strong>${a.scheduledTime}</strong></p>
            <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
                <button data-id="${a.id}" class="check-in-btn bg-green-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-green-600">Marcar Chegada</button>
                <button data-id="${a.id}" class="faltou-btn bg-yellow-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-yellow-600">Faltou</button>
            </div>
        `;
        return card;
    });

    render(lists.aguardando, filtered.aguardando, (a, index) => {
        const card = document.createElement('div');
        card.className = `relative bg-white p-4 rounded-lg shadow-sm ${getPriorityClass(a.priority)}`;
        const arrival = `Chegou: ${new Date(a.arrivalTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
        card.innerHTML = `
            <p class="font-bold text-lg">${index + 1}. ${a.name}</p>
            <p class="text-sm">Assunto: <strong>${a.subject}</strong></p>
            <p class="text-sm text-gray-500">${arrival}</p>
            <div class="mt-3 grid grid-cols-1 gap-2 text-sm">
                <button data-id="${a.id}" class="attend-btn bg-blue-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-blue-600">Atender</button>
            </div>
        `;
        return card;
    });
    
    render(lists.emAtendimento, filtered.emAtendimento, a => {
        const card = document.createElement('div');
        card.className = `relative bg-blue-50 p-4 rounded-lg shadow-sm border-l-4 border-blue-400`;
        card.innerHTML = `
            <p class="font-bold text-lg">${a.name}</p>
            <p class="text-sm mt-1">Por: <strong class="text-blue-700">${a.attendant || 'A definir'}</strong></p>
            <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
                <button data-id="${a.id}" class="finalize-btn bg-green-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-green-600">Finalizar</button>
                <button data-id="${a.id}" class="delegate-btn bg-purple-100 text-purple-700 font-semibold py-2 px-3 rounded-lg hover:bg-purple-200">Delegar</button>
            </div>
             <button data-id="${a.id}" class="return-to-aguardando-btn w-full bg-yellow-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-yellow-600 mt-2 text-sm">Voltar p/ Fila</button>
        `;
        return card;
    });

    render(lists.finalizado, filtered.finalizado, a => {
        const card = document.createElement('div');
        card.className = 'relative bg-green-50 p-4 rounded-lg shadow-sm border-green-200';
        const finalizadoExternamente = a.finalizadoPeloColaborador ? `<span class="text-xs font-bold text-blue-600 bg-blue-100 px-2 py-1 rounded-full">Via Link</span>` : '';
        card.innerHTML = `
            <p class="font-bold text-lg">${a.name}</p>
            <p class="text-sm">Finalizado por: <strong>${a.attendant || 'N/A'}</strong> ${finalizadoExternamente}</p>
            <p class="text-sm text-gray-500">Horário: ${new Date(a.attendedTime).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'})}</p>
        `;
        return card;
    });

    render(lists.faltoso, filtered.faltoso, a => {
        const card = document.createElement('div');
        card.className = 'relative bg-red-50 p-4 rounded-lg shadow-sm border-red-200';
        card.innerHTML = `
            <p class="font-bold text-lg">${a.name}</p>
            <p class="text-sm">Agendado: <strong>${a.scheduledTime}</strong></p>
            <button data-id="${a.id}" class="return-to-pauta-from-faltoso-btn w-full bg-gray-500 text-white font-semibold py-1 rounded-lg hover:bg-gray-600 text-xs mt-2">Reverter</button>
        `;
        return card;
    });
};

const setupFirebaseListeners = (pautaId) => {
    if (unsubscribeFromAttendances) unsubscribeFromAttendances();
    if (unsubscribeFromCollaborators) unsubscribeFromCollaborators();
    
    const attendanceCollectionRef = collection(db, "pautas", pautaId, "attendances");
    unsubscribeFromAttendances = onSnapshot(attendanceCollectionRef, (snapshot) => {
        allAssisted = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderAssistedList();
    });

    const collaboratorsCollectionRef = collection(db, "pautas", pautaId, "collaborators");
    unsubscribeFromCollaborators = onSnapshot(collaboratorsCollectionRef, (snapshot) => {
        colaboradores = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => a.nome.localeCompare(b.nome));
    });
};

const loadPauta = async (pautaId, pautaName, pautaType) => {
    currentPautaId = pautaId;
    document.getElementById('pauta-title').textContent = pautaName;
    document.body.dataset.currentPautaId = pautaId;
    
    const pautaDoc = await getDoc(doc(db, "pautas", pautaId));
    if (!pautaDoc.exists()) return;

    currentPautaData = pautaDoc.data();
    currentPautaOwnerId = currentPautaData.owner;
    
    setupFirebaseListeners(pautaId);
    showScreen('app');
};

const deletePauta = (pautaId) => {
     const pautaRef = doc(db, "pautas", pautaId);
     deleteDoc(pautaRef).then(() => {
        showNotification("Pauta apagada com sucesso.", "info");
     }).catch(e => {
        showNotification("Erro ao apagar pauta.", "error");
     });
}

const showPautaSelectionScreen = (userId) => {
    const pautasList = document.getElementById('pautas-list');
    pautasList.innerHTML = '<p class="col-span-full text-center">Carregando pautas...</p>';
    const q = query(collection(db, "pautas"), where("members", "array-contains", userId));

    onSnapshot(q, (snapshot) => {
        pautasList.innerHTML = ''; 
        if (snapshot.empty) {
            pautasList.innerHTML = '<p class="col-span-full text-center text-gray-500">Nenhuma pauta encontrada.</p>';
            return;
        }
        snapshot.docs.forEach((docSnap) => {
            const pauta = docSnap.data();
            const card = document.createElement('div');
            card.className = "relative bg-white p-6 rounded-lg shadow-md hover:shadow-xl transition-shadow cursor-pointer";
            card.dataset.pautaId = docSnap.id;
            card.dataset.pautaName = pauta.name;
            card.dataset.pautaType = pauta.type;

            if (pauta.owner === auth.currentUser?.uid) {
                card.innerHTML = `
                <button class="delete-pauta-btn absolute top-3 right-3 p-1 rounded-full text-gray-400 hover:bg-red-100 hover:text-red-600">
                    <svg class="pointer-events-none" xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>`;
            }
            card.innerHTML += `
                <h3 class="font-bold text-xl mb-2 pointer-events-none">${pauta.name}</h3>
                <p class="text-gray-600 pointer-events-none">Membros: ${pauta.memberEmails?.length || 1}</p>
            `;
            pautasList.appendChild(card);
        });
    });
    showScreen('pautaSelection');
}


// Inicialização e Eventos Globais
document.addEventListener('DOMContentLoaded', () => {
    try {
        const firebaseConfig = { apiKey: "AIzaSyCrLwXmkxgeVoB8TwRI7pplCVQETGK0zkE", authDomain: "pauta-ce162.firebaseapp.com", projectId: "pauta-ce162", storageBucket: "pauta-ce162.appspot.com", messagingSenderId: "87113750208", appId: "1:87113750208:web:4abba0024f4d4af699bf25" };
        initializeApp(firebaseConfig);
        db = getFirestore();
        auth = getAuth();
        onAuthStateChanged(auth, async (user) => {
            if (user) {
                const userDoc = await getDoc(doc(db, "users", user.uid));
                if (userDoc.exists() && userDoc.data().status === 'approved') {
                    currentUserName = userDoc.data().name || user.email;
                    showPautaSelectionScreen(user.uid);
                } else {
                    showScreen('loading');
                    loadingContainer.innerHTML = '<p class="text-center text-yellow-700 font-semibold">Sua conta está pendente de aprovação.<br>Por favor, aguarde ou contate um administrador.</p><button id="logout-btn-pending" class="mt-4 bg-gray-600 text-white font-bold py-2 px-4 rounded-lg">Sair</button>';
                    document.getElementById('logout-btn-pending').addEventListener('click', () => signOut(auth));
                }
            } else {
                showScreen('login');
            }
        });
    } catch(e) {
         loadingContainer.innerHTML = '<p class="text-red-600">Erro fatal ao carregar a aplicação. Verifique a consola.</p>';
    }

    // Event Delegation para toda a página
    document.body.addEventListener('click', async (e) => {
        const button = e.target.closest('button');
        if (!button) return;

        // Ações que não precisam de contexto de pauta
        if(button.id === 'logout-btn-main' || button.id === 'logout-btn-app') return signOut(auth);
        if(button.id === 'create-pauta-btn') return document.getElementById('pauta-type-modal').classList.remove('hidden');
        if(button.id === 'actions-toggle') {
            document.getElementById('actions-panel').classList.toggle('opacity-0');
            document.getElementById('actions-arrow').classList.toggle('rotate-180');
            return;
        }
        if(button.id === 'toggle-logic-btn-padrao') {
             const explanation = document.getElementById('logic-explanation-padrao-content');
             explanation.classList.toggle('hidden');
             button.textContent = explanation.classList.contains('hidden') ? 'Por que esta ordem é justa? (Clique para expandir)' : 'Ocultar explicação';
             return;
        }
        if(button.id === 'download-pdf-btn') {
            const { jsPDF } = window.jspdf;
            const docPDF = new jsPDF();
            const finalizados = allAssisted.filter(a => a.status === 'atendido');
            if (finalizados.length === 0) return showNotification("Não há atendimentos finalizados para gerar o relatório.", "info");
            docPDF.text(`Relatório de Atendimentos Finalizados - ${currentPautaData.name}`, 14, 22);
            docPDF.autoTable({
                head: [["#", "Nome", "Assunto", "Atendente", "Finalizado"]],
                body: finalizados.map((item, i) => [i + 1, item.name, item.subject, item.attendant || 'N/A', new Date(item.attendedTime).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'})]),
                startY: 30
            });
            docPDF.save(`relatorio_${currentPautaData.name.replace(/\s/g, '_')}.pdf`);
            return;
        }
        
        // Ações que precisam de contexto (currentPautaId)
        if (!currentPautaId) return;
        const id = button.dataset.id;
        const docRef = id ? doc(db, "pautas", currentPautaId, "attendances", id) : null;

        if (button.classList.contains('attend-btn')) {
            assistedIdToHandle = id;
            const datalist = document.getElementById('collaborators-list');
            datalist.innerHTML = '';
            colaboradores.forEach(c => {
                const option = document.createElement('option');
                option.value = c.nome;
                datalist.appendChild(option);
            });
            document.getElementById('attendant-modal').classList.remove('hidden');
        } else if (button.id === 'confirm-attendant-btn') {
            const attendantName = document.getElementById('attendant-name').value.trim();
            if(assistedIdToHandle) {
                await updateDoc(doc(db, "pautas", currentPautaId, "attendances", assistedIdToHandle), getUpdatePayload({ status: 'em-atendimento', attendant: attendantName }));
                document.getElementById('attendant-modal').classList.add('hidden');
                document.getElementById('attendant-name').value = '';
            }
        } else if (button.classList.contains('delegate-btn')) {
            assistedIdToHandle = id;
            const assisted = allAssisted.find(a => a.id === id);
            document.getElementById('delegation-assisted-name').textContent = assisted.name;
            const select = document.getElementById('delegation-collaborator-select');
            select.innerHTML = '<option value="">Selecione...</option>';
            colaboradores.forEach(c => select.add(new Option(c.nome, c.email)));
            document.getElementById('delegation-modal').classList.remove('hidden');
        } else if(button.id === 'generate-delegation-link-btn') {
            const select = document.getElementById('delegation-collaborator-select');
            if (!select.value) return showNotification("Selecione um colaborador.", "error");
            
            const collaboratorName = select.options[select.selectedIndex].text;
            const baseUrl = window.location.origin + window.location.pathname.replace('index.html', '');
            const url = `${baseUrl}atendimento_externo.html?pautaId=${currentPautaId}&assistidoId=${assistedIdToHandle}&collaboratorName=${encodeURIComponent(collaboratorName)}`;

            const linkText = document.getElementById('generated-link-text');
            linkText.value = url;
            document.getElementById('generated-link-container').classList.remove('hidden');
            navigator.clipboard.writeText(url).then(() => showNotification('Link copiado!', 'success'));
        } else if (button.classList.contains('finalize-btn') && docRef) {
            if (confirm("Finalizar este atendimento?")) {
                await updateDoc(docRef, getUpdatePayload({ status: 'atendido', attendedTime: new Date().toISOString() }));
                showNotification("Atendimento finalizado!");
            }
        } else if (button.classList.contains('return-to-aguardando-btn') && docRef) {
            await updateDoc(docRef, getUpdatePayload({ status: 'aguardando', attendant: null }));
        } else if (button.classList.contains('check-in-btn') && docRef) {
             document.getElementById('arrival-time-input').value = new Date().toTimeString().slice(0, 5);
             assistedIdToHandle = id;
             document.getElementById('arrival-modal').classList.remove('hidden');
        } else if (button.id === 'confirm-arrival-btn') {
            const arrivalTime = document.getElementById('arrival-time-input').value;
            if(assistedIdToHandle && arrivalTime) {
                const arrivalDate = new Date();
                const [h,m] = arrivalTime.split(':');
                arrivalDate.setHours(h,m,0,0);
                await updateDoc(doc(db, "pautas", currentPautaId, "attendances", assistedIdToHandle), getUpdatePayload({ status: 'aguardando', arrivalTime: arrivalDate.toISOString() }));
                document.getElementById('arrival-modal').classList.add('hidden');
            }
        }
        
        // Fechar Modais
        if (button.id.startsWith('cancel-') || button.id.startsWith('close-')) {
            const modal = button.closest('.fixed');
            if (modal) modal.classList.add('hidden');
        }
    });

    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = e.target.elements['login-email'].value;
        const password = e.target.elements['login-password'].value;
        try { await signInWithEmailAndPassword(auth, email, password); } 
        catch (error) { showNotification('Email ou senha inválidos.', 'error'); }
    });
});

