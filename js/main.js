import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendEmailVerification, sendPasswordResetEmail, reauthenticateWithCredential, EmailAuthProvider } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc, writeBatch, getDoc, setDoc, query, where, getDocs, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { subjectTree, flattenTreeWithObjects } from './assuntos.js';

const flatSubjects = flattenTreeWithObjects(subjectTree);

let db, auth, allAssisted = [], currentPautaId = null, unsubscribeFromAttendances = () => {}, currentUserName = '', currentPautaOwnerId = null, isPautaClosed = false;
let currentPautaData = null;
let assistedIdToHandle = null;
let currentChecklistAction = null;
let colaboradores = [];
let editCollaboratorId = null;
let unsubscribeFromCollaborators = () => {};

const loadingContainer = document.getElementById('loading-container');
const loginContainer = document.getElementById('login-container');
const pautaSelectionContainer = document.getElementById('pauta-selection-container');
const appContainer = document.getElementById('app-container');
const loadingText = document.getElementById('loading-text');

const normalizeText = (str) => {
    if (!str) return '';
    return str.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
};

const getPriorityClass = (priority) => ({'URGENTE':'priority-urgente','Máxima':'priority-maxima','Média':'priority-media','Mínima':'priority-minima'}[priority]||'');

const getUpdatePayload = (data) => ({
    ...data,
    lastActionBy: currentUserName,
    lastActionTimestamp: new Date().toISOString()
});

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

const togglePautaLock = (isClosed) => {
    isPautaClosed = isClosed;
    const isOwner = auth.currentUser?.uid === currentPautaOwnerId;
    
    const elementsToToggle = document.querySelectorAll('button, input, a, textarea, select');
    elementsToToggle.forEach(el => {
        const isExempt = el.closest('#logout-btn-app, #back-to-pautas-btn') || el.id === 'logout-btn-app' || el.id === 'back-to-pautas-btn';
        if (!isExempt) el.disabled = isClosed;
    });

    document.getElementById('closed-pauta-alert').classList.toggle('hidden', !isClosed);
    if (isOwner) {
        document.getElementById('close-pauta-btn').classList.toggle('hidden', isClosed);
        document.getElementById('reopen-pauta-btn').classList.toggle('hidden', !isClosed);
    } else {
        document.getElementById('close-pauta-btn').classList.add('hidden');
        document.getElementById('reopen-pauta-btn').classList.add('hidden');
    }
};

const renderAssistedList = () => {
    allAssisted.forEach(a => {
        if (a.status === 'aguardando' && a.priority !== 'URGENTE') a.priority = getPriorityLevel(a);
    });

    const lists = {
        pauta: document.getElementById('pauta-list'),
        aguardando: document.getElementById('aguardando-list'),
        atendido: document.getElementById('atendidos-list'),
        faltoso: document.getElementById('faltosos-list')
    };
    Object.values(lists).forEach(el => el.innerHTML = '');

    const currentMode = document.getElementById('tab-agendamento').classList.contains('tab-active') ? 'agendamento' : 'avulso';
    const searchTerms = {
        pauta: normalizeText(document.getElementById('pauta-search').value),
        aguardando: normalizeText(document.getElementById('aguardando-search').value),
        atendido: normalizeText(document.getElementById('atendidos-search').value),
        faltoso: normalizeText(document.getElementById('faltosos-search').value)
    };
    const searchFilter = (a, term) => !term || ['name', 'cpf', 'subject'].some(key => normalizeText(a[key]).includes(term));

    const filtered = {
        pauta: allAssisted.filter(a => a.status === 'pauta' && a.type === 'agendamento' && searchFilter(a, searchTerms.pauta)),
        aguardando: allAssisted.filter(a => a.status === 'aguardando' && a.type === currentMode && searchFilter(a, searchTerms.aguardando)),
        atendido: allAssisted.filter(a => a.status === 'atendido' && a.type === currentMode && searchFilter(a, searchTerms.atendido)),
        faltoso: allAssisted.filter(a => a.status === 'faltoso' && a.type === 'agendamento' && searchFilter(a, searchTerms.faltoso))
    };

    filtered.pauta.sort((a, b) => (a.scheduledTime || '23:59').localeCompare(b.scheduledTime || '23:59'));
    filtered.atendido.sort((a, b) => new Date(b.attendedTime) - new Date(a.attendedTime));
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

    ['pauta', 'aguardando', 'atendido', 'faltoso'].forEach(status => {
        const countEl = document.getElementById(`${status === 'atendido' ? 'atendidos' : status}-count`);
        if (countEl) countEl.textContent = filtered[status].length;
    });

    const render = (el, data, generator) => {
        if (data.length === 0) el.innerHTML = `<p class="text-gray-500 text-center p-4">Nenhum resultado.</p>`;
        else data.forEach((item, index) => el.appendChild(generator(item, index)));
    };

    render(lists.pauta, filtered.pauta, a => {
        const card = document.createElement('div');
        card.className = 'relative bg-gray-50 p-4 rounded-lg shadow-sm border';
        card.innerHTML = `
            <button data-id="${a.id}" class="delete-btn absolute top-2 right-2 text-gray-400 hover:text-red-600 p-1 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M11 1.5v1h3.5a.5.5 0 0 1 0 1h-.538l-.853 10.66A2 2 0 0 1 11.115 16h-6.23a2 2 0 0 1-1.994-1.84L2.038 3.5H1.5a.5.5 0 0 1 0-1H5v-1A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5zM4.5 5.029l.5 8.5a.5.5 0 1 0 .998-.06l-.5-8.5a.5.5 0 1 0-.998.06zm3 0l.5 8.5a.5.5 0 1 0 .998-.06l-.5-8.5a.5.5 0 1 0-.998.06zm3 .5a.5.5 0 0 0-1 0v8.5a.5.5 0 0 0 1 0v-8.5z"/></svg></button>
            <p class="font-bold text-lg">${a.name}</p>
            ${a.cpf ? `<p class="text-sm text-gray-500">CPF: <strong>${a.cpf}</strong></p>` : ''}
            <p>Assunto: <strong>${a.subject}</strong></p>
            <p>Agendado: <strong>${a.scheduledTime}</strong></p>
            <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
                <button data-id="${a.id}" class="check-in-btn bg-green-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-green-600">Marcar Chegada</button>
                <button data-id="${a.id}" class="faltou-btn bg-yellow-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-yellow-600">Faltou</button>
                <button data-id="${a.id}" class="edit-assisted-btn col-span-2 bg-gray-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-gray-600">Editar Dados</button>
            </div>
            ${a.lastActionBy ? `<div class="text-xs text-right text-gray-400 mt-2 pt-2 border-t">Última ação por: <strong>${a.lastActionBy}</strong></div>` : ''}
        `;
        return card;
    });

    render(lists.aguardando, filtered.aguardando, (a, index) => {
        const card = document.createElement('div');
        card.className = `relative bg-white p-4 rounded-lg shadow-sm ${getPriorityClass(a.priority)}`;
        const arrival = a.type === 'agendamento' && a.scheduledTime ? `Agendado: ${a.scheduledTime} | Chegou: ${new Date(a.arrivalTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : `Chegada: ${new Date(a.arrivalTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
        const returnToPautaBtn = a.type === 'agendamento' ? `<button data-id="${a.id}" class="return-to-pauta-btn w-full bg-gray-400 text-white font-semibold py-1 rounded-lg hover:bg-gray-500 text-xs mt-1">Voltar p/ Pauta</button>` : '';
        card.innerHTML = `
            <button data-id="${a.id}" class="delete-btn absolute top-2 right-2 text-gray-400 hover:text-red-600 p-1 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M11 1.5v1h3.5a.5.5 0 0 1 0 1h-.538l-.853 10.66A2 2 0 0 1 11.115 16h-6.23a2 2 0 0 1-1.994-1.84L2.038 3.5H1.5a.5.5 0 0 1 0-1H5v-1A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5zm-5 0v1h4v-1a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5zM4.5 5.029l.5 8.5a.5.5 0 1 0 .998-.06l-.5-8.5a.5.5 0 1 0-.998.06zm3 0l.5 8.5a.5.5 0 1 0 .998-.06l-.5-8.5a.5.5 0 1 0-.998.06zm3 .5a.5.5 0 0 0-1 0v8.5a.5.5 0 0 0 1 0v-8.5z"/></svg></button>
            <p class="font-bold text-lg">${index + 1}. ${a.name}</p>
            <p class="text-sm">Assunto: <strong>${a.subject}</strong></p>
            <p class="text-sm text-gray-500">${arrival}</p>
            <button data-id="${a.id}" class="view-details-btn text-indigo-600 hover:text-indigo-800 text-sm hover:underline font-semibold py-1">Ver Detalhes</button>
            <div class="mt-3 grid grid-cols-2 lg:grid-cols-3 gap-2">
                <button data-id="${a.id}" class="attend-btn bg-blue-500 text-white font-semibold py-2 rounded-lg hover:bg-blue-600 text-sm">Atender</button>
                ${a.priority !== 'URGENTE' ? `<button data-id="${a.id}" class="priority-btn bg-red-500 text-white font-semibold py-2 rounded-lg hover:bg-red-600 text-sm">Prioridade</button>` : ''}
                <button data-id="${a.id}" class="edit-assisted-btn bg-gray-500 text-white font-semibold py-2 rounded-lg hover:bg-gray-600 text-sm">Editar</button>
            </div>
            ${returnToPautaBtn ? `<div class="mt-2">${returnToPautaBtn}</div>` : ''}
            ${a.lastActionBy ? `<div class="text-xs text-right text-gray-400 mt-2 pt-2 border-t">Última ação por: <strong>${a.lastActionBy}</strong></div>` : ''}
        `;
        return card;
    });

    render(lists.atendido, filtered.atendido, a => {
        const card = document.createElement('div');
        card.className = 'relative bg-green-50 p-4 rounded-lg shadow-sm border-green-200';
        const totalAssuntos = 1 + (a.demandas?.quantidade || 0);
        const demandasInfo = a.demandas?.descricoes?.length > 0 ? `<div class="mt-2 text-xs bg-gray-100 p-2 rounded"><strong class="text-gray-700">Demandas Adicionais (${a.demandas.quantidade || 0}):</strong><ul class="list-disc list-inside pl-2 text-gray-600">${a.demandas.descricoes.map(d => `<li>${d}</li>`).join('')}</ul></div>` : '';
        const finalizadoExternamente = a.finalizadoPeloColaborador ? `<span class="text-xs font-bold text-blue-600 bg-blue-100 px-2 py-1 rounded-full">Finalizado por Colaborador</span>` : '';
        card.innerHTML = `
            <div class="flex justify-between items-start">
                <p class="font-bold text-lg">${a.name} ${totalAssuntos > 1 ? `<span class="text-sm font-medium text-green-600">(${totalAssuntos} assuntos)</span>` : ''}</p>
                <button class="toggle-details-btn text-gray-500 hover:text-gray-800 p-1">
                     <svg class="pointer-events-none" style="transform: rotate(180deg);" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>
                </button>
            </div>
            <div class="card-details mt-2 space-y-2 hidden">
                ${a.cpf ? `<p class="text-sm">CPF: <strong>${a.cpf}</strong></p>` : ''}
                <p class="text-sm">Assunto Principal: <strong>${a.subject}</strong></p>
                <div class="text-xs text-gray-600 grid grid-cols-3 gap-2 text-center border-y py-2">
                    <div><strong>Agendado:</strong><br>${a.scheduledTime || 'N/A'}</div>
                    <div><strong>Chegou:</strong><br>${a.arrivalTime ? new Date(a.arrivalTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'N/A'}</div>
                    <div><strong>Finalizado:</strong><br>${a.attendedTime ? new Date(a.attendedTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'N/A'}</div>
                </div>
                ${demandasInfo}
                <div class="flex justify-between items-center mt-2">
                    <p class="text-sm">Por: <strong>${a.attendant || 'Não informado'}</strong></p>
                    ${finalizadoExternamente}
                </div>
                <div class="flex items-center gap-1 flex-wrap justify-center border-t pt-2 mt-2">
                    <button data-id="${a.id}" class="manage-demands-btn text-blue-600 hover:text-blue-800 font-semibold text-xs py-1 px-2 rounded hover:bg-blue-100">Demandas</button>
                    <button data-id="${a.id}" class="edit-assisted-btn text-gray-600 hover:text-gray-800 font-semibold text-xs py-1 px-2 rounded hover:bg-gray-100">Dados</button>
                    <button data-id="${a.id}" class="edit-attendant-btn text-green-600 hover:text-green-800 font-semibold text-xs py-1 px-2 rounded hover:bg-green-100">Atendente</button>
                    <button data-id="${a.id}" class="delegate-btn text-purple-600 hover:text-purple-800 font-semibold text-xs py-1 px-2 rounded hover:bg-purple-100">Delegar Finalização</button>
                    <button data-id="${a.id}" class="delete-btn text-red-600 hover:text-red-800 font-semibold text-xs py-1 px-2 rounded hover:bg-red-100">Deletar</button>
                </div>
                <div class="mt-2 pt-2 border-t flex justify-between items-center">
                    ${a.lastActionBy ? `<p class="text-xs text-gray-500">Última ação por: <strong>${a.lastActionBy}</strong></p>` : '<div></div>'}
                    <button data-id="${a.id}" class="return-to-aguardando-btn bg-yellow-500 text-white font-semibold py-1 px-3 rounded-lg hover:bg-yellow-600 text-xs">Voltar p/ Aguardando</button>
                </div>
            </div>`;
        return card;
    });

    render(lists.faltoso, filtered.faltoso, a => {
        const card = document.createElement('div');
        card.className = 'relative bg-red-50 p-4 rounded-lg shadow-sm border-red-200';
        card.innerHTML = `
            <button data-id="${a.id}" class="delete-btn absolute top-2 right-2 text-gray-400 hover:text-red-600 p-1 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M11 1.5v1h3.5a.5.5 0 0 1 0 1h-.538l-.853 10.66A2 2 0 0 1 11.115 16h-6.23a2 2 0 0 1-1.994-1.84L2.038 3.5H1.5a.5.5 0 0 1 0-1H5v-1A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5zM6 6.5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0v-6a.5.5 0 0 1 .5-.5zm3 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0v-6a.5.5 0 0 1 .5-.5zm-5 1a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1h-6z"/></svg></button>
            <p class="font-bold text-lg">${a.name}</p>
            <div class="mt-2 space-y-2">
                ${a.cpf ? `<p class="text-sm">CPF: <strong>${a.cpf}</strong></p>` : ''}
                <p class="text-sm">Assunto: <strong>${a.subject}</strong></p>
                <p class="text-sm">Agendado: <strong>${a.scheduledTime}</strong></p>
                <div class="mt-3">
                    <button data-id="${a.id}" class="return-to-pauta-from-faltoso-btn w-full bg-gray-500 text-white font-semibold py-1 rounded-lg hover:bg-gray-600 text-xs">Revertido para Pauta</button>
                </div>
            </div>
            ${a.lastActionBy ? `<div class="text-xs text-right text-gray-400 mt-2 pt-2 border-t">Última ação por: <strong>${a.lastActionBy}</strong></div>` : ''}
        `;
        return card;
    });

    togglePautaLock(isPautaClosed);
};

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

// ... O restante do código de 'js/main.js' continua aqui, sem alterações ...
// ... (código omitido para brevidade) ...

// Adicione este novo listener de evento DENTRO do 'DOMContentLoaded'
document.getElementById('delegation-collaborator-select').addEventListener('change', (e) => {
    document.getElementById('delegation-collaborator-email').value = e.target.value;
});

