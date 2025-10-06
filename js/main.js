import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail, reauthenticateWithCredential, EmailAuthProvider } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc, writeBatch, getDoc, setDoc, query, where, getDocs, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { subjectTree, flattenTreeWithObjects } from './assuntos.js';

// --- VARIÁVEIS GLOBAIS ---
let db, auth, currentPautaId = null, currentPautaData = null, currentUserName = '', currentPautaOwnerId = null, isPautaClosed = false;
let allAssisted = [], colaboradores = [];
let unsubscribeFromAttendances = () => {}, unsubscribeFromCollaborators = () => {};
let assistedIdToHandle = null, editCollaboratorId = null;

// --- FUNÇÕES UTILITÁRIAS ---
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

// --- LÓGICA DE RENDERIZAÇÃO E ESTADO DA UI ---
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

const switchTab = (tabName) => {
    // ... (código existente da função switchTab)
};

const togglePautaLock = (isClosed) => {
    // ... (código existente da função togglePautaLock)
};

const renderAssistedList = () => {
    // ... (código existente da função renderAssistedList, sem alterações)
};


// --- FUNÇÕES PRINCIPAIS DA APLICAÇÃO ---
const loadPauta = async (pautaId, pautaName, pautaType) => {
    // ... (código existente da função loadPauta)
};

const setupRealtimeListeners = (pautaId) => {
    // ... (código existente para listeners de 'attendances' e 'collaborators')
};


// --- INICIALIZAÇÃO E AUTENTICAÇÃO ---
const main = () => {
    // ... (código de inicialização do Firebase)
};

const handleAuthState = () => {
    // ... (código de gestão de estado de autenticação)
};


// --- CONFIGURAÇÃO DE EVENT LISTENERS ---
function setupEventListeners() {
    // -- Autenticação e Navegação Principal --
    document.getElementById('login-form').addEventListener('submit', handleLogin);
    document.getElementById('register-form').addEventListener('submit', handleRegister);
    document.getElementById('forgot-password-link').addEventListener('click', handleForgotPassword);
    document.getElementById('logout-btn-main').addEventListener('click', () => signOut(auth));
    document.getElementById('logout-btn-app').addEventListener('click', () => signOut(auth));
    document.getElementById('back-to-pautas-btn').addEventListener('click', handleBackToPautas);

    // -- Criação de Pauta (Fluxo em Múltiplos Modais) --
    document.getElementById('create-pauta-btn').addEventListener('click', () => document.getElementById('pauta-type-modal').classList.remove('hidden'));
    document.querySelectorAll('.pauta-type-btn').forEach(btn => btn.addEventListener('click', handlePautaTypeSelection));
    document.getElementById('next-to-ordem-btn').addEventListener('click', handleNextToOrdem);
    document.getElementById('confirm-create-pauta-final-btn').addEventListener('click', handleConfirmCreatePauta);

    // -- Ações de Delegação (Novo) --
    document.getElementById('generate-delegation-link-btn').addEventListener('click', handleGenerateDelegationLink);
    document.getElementById('copy-delegation-link-btn').addEventListener('click', () => navigator.clipboard.writeText(document.getElementById('generated-link-text').value).then(() => showNotification('Link copiado!', 'info')));

    // -- Listeners para os Modais (Botões de Cancelar/Fechar) --
    document.querySelectorAll('[id^="cancel-"], [id^="close-"]').forEach(btn => {
        btn.addEventListener('click', () => btn.closest('.fixed')?.classList.add('hidden'));
    });
    
    // -- Delegação de Eventos para Listas Dinâmicas --
    document.getElementById('main-content').addEventListener('click', handleMainContentClick);
    document.getElementById('pautas-list').addEventListener('click', handlePautasListClick);
}


// --- HANDLERS DE EVENTOS ESPECÍFICOS ---

function handleLogin(e) { e.preventDefault(); /* ... lógica de login ... */ }
function handleRegister(e) { e.preventDefault(); /* ... lógica de registro ... */ }
function handleForgotPassword() { /* ... lógica de esquecer senha ... */ }
function handleBackToPautas() { /* ... lógica de voltar para a seleção de pautas ... */ }

// Handlers do fluxo de criação de pauta
function handlePautaTypeSelection(e) { /* ... */ }
function handleNextToOrdem() { /* ... */ }
async function handleConfirmCreatePauta() { /* ... */ }

// Handler da delegação
function handleGenerateDelegationLink() {
    const select = document.getElementById('delegation-collaborator-select');
    if (!select.value) return showNotification("Por favor, selecione um colaborador.", "error");
    
    const collaboratorName = select.options[select.selectedIndex].text;
    const baseUrl = window.location.origin + window.location.pathname.replace('index.html', '');
    const url = `${baseUrl}atendimento_externo.html?pautaId=${currentPautaId}&assistidoId=${assistedIdToHandle}&collaboratorName=${encodeURIComponent(collaboratorName)}`;

    const linkText = document.getElementById('generated-link-text');
    linkText.value = url;
    document.getElementById('generated-link-container').classList.remove('hidden');
    
    navigator.clipboard.writeText(url).then(() => showNotification('Link copiado para a área de transferência!', 'success'));
}

// Handler para cliques na lista de pautas (para carregar uma pauta)
function handlePautasListClick(e) {
    const card = e.target.closest('[data-pauta-id]');
    if (card && !e.target.closest('button')) {
        const { pautaId, pautaName, pautaType } = card.dataset;
        loadPauta(pautaId, pautaName, pautaType);
    }
}

// Handler principal para ações dentro da pauta (listas de assistidos)
async function handleMainContentClick(e) {
    const button = e.target.closest('button');
    if (!button || !button.dataset.id) return;

    const id = button.dataset.id;
    const collectionRef = collection(db, "pautas", currentPautaId, "attendances");
    const docRef = doc(collectionRef, id);

    // Mapeamento de classes para ações
    const actions = {
        'delete-btn': async () => { if (confirm("Tem certeza?")) { await deleteDoc(docRef); showNotification("Registro apagado."); }},
        'delegate-btn': () => { 
            assistedIdToHandle = id;
            const assisted = allAssisted.find(a => a.id === id);
            document.getElementById('delegation-assisted-name').textContent = assisted.name;
            
            const select = document.getElementById('delegation-collaborator-select');
            select.innerHTML = '<option value="">Selecione...</option>';
            colaboradores.forEach(c => select.add(new Option(c.nome, c.email)));
            
            document.getElementById('delegation-modal').classList.remove('hidden');
        },
        // ... adicione outras ações aqui (check-in-btn, attend-btn, etc.)
    };

    for (const className in actions) {
        if (button.classList.contains(className)) {
            await actions[className]();
            break; 
        }
    }
}


// --- PONTO DE ENTRADA ---
document.addEventListener('DOMContentLoaded', () => {
    main();
    setupEventListeners();
});

