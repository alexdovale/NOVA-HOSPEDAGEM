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
    Object.values(lists).forEach(el => el.innerHTML = '');

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

const setupFirebase = () => {
    try {
        const firebaseConfig = { apiKey: "AIzaSyCrLwXmkxgeVoB8TwRI7pplCVQETGK0zkE", authDomain: "pauta-ce162.firebaseapp.com", projectId: "pauta-ce162", storageBucket: "pauta-ce162.appspot.com", messagingSenderId: "87113750208", appId: "1:87113750208:web:4abba0024f4d4af699bf25" };
        const app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);
        onAuthStateChanged(auth, async (user) => {
            if (user) {
                const userDoc = await getDoc(doc(db, "users", user.uid));
                if (userDoc.exists() && userDoc.data().status === 'approved') {
                    currentUserName = userDoc.data().name || user.email;
                    showPautaSelectionScreen(user.uid);
                } else {
                    showScreen('loading');
                    loadingText.innerHTML = 'Sua conta está pendente de aprovação. <br> Por favor, aguarde ou contate um administrador.';
                }
            } else {
                showScreen('login');
            }
        });
    } catch (error) {
        console.error("Erro ao inicializar o Firebase: ", error);
        loadingText.textContent = 'Erro na configuração do Firebase.';
    }
};

const attachInitialEventListeners = () => {
    // Delegação de eventos para conteúdo dinâmico
    document.getElementById('pautas-list').addEventListener('click', (e) => {
        const card = e.target.closest('[data-pauta-id]');
        if (card) {
            if (e.target.closest('.delete-pauta-btn')) {
                if (confirm(`Tem certeza que deseja apagar a pauta "${card.dataset.pautaName}"?`)) {
                    deletePauta(card.dataset.pautaId);
                }
            } else {
                const { pautaId, pautaName, pautaType } = card.dataset;
                loadPauta(pautaId, pautaName, pautaType);
            }
        }
    });
    
    // Eventos estáticos
    document.getElementById('create-pauta-btn').addEventListener('click', () => {
        document.getElementById('pauta-type-modal').classList.remove('hidden');
    });

    document.getElementById('actions-toggle').addEventListener('click', () => {
        const panel = document.getElementById('actions-panel');
        const arrow = document.getElementById('actions-arrow');
        panel.classList.toggle('opacity-0');
        panel.classList.toggle('scale-90');
        panel.classList.toggle('pointer-events-none');
        arrow.classList.toggle('rotate-180');
    });

    document.getElementById('toggle-logic-btn-padrao').addEventListener('click', (e) => {
        const explanation = document.getElementById('logic-explanation-padrao-content');
        const isHidden = explanation.classList.toggle('hidden');
        e.target.textContent = isHidden ? 'Por que esta ordem é justa? (Clique para expandir)' : 'Ocultar explicação';
    });

    document.getElementById('download-pdf-btn').addEventListener('click', () => {
        const { jsPDF } = window.jspdf;
        const docPDF = new jsPDF();
        const finalizados = allAssisted.filter(a => a.status === 'atendido');

        if (finalizados.length === 0) return showNotification("Não há atendimentos finalizados para gerar o relatório.", "info");
        
        docPDF.text(`Relatório de Atendimentos Finalizados - ${currentPautaData.name}`, 14, 22);
        const tableColumn = ["#", "Nome", "Assunto Principal", "Atendente", "Finalizado"];
        const tableRows = finalizados.map((item, index) => [
            index + 1, item.name, item.subject, item.attendant || 'N/A',
            new Date(item.attendedTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        ]);
        docPDF.autoTable(tableColumn, tableRows, { startY: 30 });
        docPDF.save(`relatorio_finalizados_${currentPautaData.name.replace(/\s/g, '_')}.pdf`);
    });

    // Listener para todos os modais e botões de ação
    document.getElementById('app-container').addEventListener('click', async e => {
        const button = e.target.closest('button');
        if (!button) return;

        const id = button.dataset.id;
        if (!id || !currentPautaId) return;

        const docRef = doc(db, "pautas", currentPautaId, "attendances", id);
        
        if (button.classList.contains('attend-btn')) {
            assistedIdToHandle = id;
            const datalist = document.getElementById('collaborators-list');
            datalist.innerHTML = '';
            colaboradores.forEach(c => datalist.add(new Option(c.nome, c.nome)));
            document.getElementById('attendant-modal').classList.remove('hidden');
        } else if(button.classList.contains('delegate-btn')) {
            assistedIdToHandle = id;
            const assisted = allAssisted.find(a => a.id === id);
            document.getElementById('delegation-assisted-name').textContent = assisted.name;
            const select = document.getElementById('delegation-collaborator-select');
            select.innerHTML = '<option value="">Selecione um colaborador</option>';
            colaboradores.forEach(c => select.add(new Option(c.nome, c.email)));
            document.getElementById('delegation-modal').classList.remove('hidden');
        } else if (button.classList.contains('finalize-btn')) {
            if (confirm("Finalizar este atendimento?")) {
                await updateDoc(docRef, getUpdatePayload({ status: 'atendido', attendedTime: new Date().toISOString() }));
                showNotification("Atendimento finalizado!");
            }
        }
    });

     document.getElementById('confirm-attendant-btn').addEventListener('click', async () => {
        const attendantName = document.getElementById('attendant-name').value.trim();
        if(assistedIdToHandle){
            await updateDoc(doc(db, "pautas", currentPautaId, "attendances", assistedIdToHandle), getUpdatePayload({ status: 'em-atendimento', attendant: attendantName }));
            document.getElementById('attendant-modal').classList.add('hidden');
        }
    });

    document.getElementById('generate-delegation-link-btn').addEventListener('click', () => {
        const select = document.getElementById('delegation-collaborator-select');
        if (!select.value) return showNotification("Selecione um colaborador.", "error");
        
        const collaboratorName = select.options[select.selectedIndex].text;
        const baseUrl = window.location.origin + window.location.pathname.replace('index.html', '');
        const url = `${baseUrl}atendimento_externo.html?pautaId=${currentPautaId}&assistidoId=${assistedIdToHandle}&collaboratorName=${encodeURIComponent(collaboratorName)}`;

        const linkText = document.getElementById('generated-link-text');
        linkText.value = url;
        document.getElementById('generated-link-container').classList.remove('hidden');
        navigator.clipboard.writeText(url).then(() => showNotification('Link copiado!', 'success'));
    });
};


document.addEventListener('DOMContentLoaded', () => {
    setupFirebase();
    attachInitialEventListeners();
});

