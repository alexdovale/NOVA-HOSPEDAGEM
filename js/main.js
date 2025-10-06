import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail, reauthenticateWithCredential, EmailAuthProvider } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
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
const pautaSelectionContainer = document.getElementById('pautaSelection-container');
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
            <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
                <button data-id="${a.id}" class="attend-btn bg-blue-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-blue-600">Atender</button>
                <button data-id="${a.id}" class="delegate-btn bg-purple-100 text-purple-700 font-semibold py-2 px-3 rounded-lg hover:bg-purple-200">Delegar</button>
                <button data-id="${a.id}" class="edit-assisted-btn bg-gray-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-gray-600">Editar</button>
                ${a.priority !== 'URGENTE' ? `<button data-id="${a.id}" class="priority-btn bg-red-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-red-600">Prioridade</button>` : ''}
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

const setupRealtimeListener = (pautaId) => {
    if (unsubscribeFromAttendances) unsubscribeFromAttendances();
    const attendanceCollectionRef = collection(db, "pautas", pautaId, "attendances");
    unsubscribeFromAttendances = onSnapshot(attendanceCollectionRef, (snapshot) => {
        allAssisted = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderAssistedList();
    }, (error) => console.error("Erro no listener do Firestore: ", error));
};

const loadPauta = async (pautaId, pautaName, pautaType) => {
    currentPautaId = pautaId;
    document.getElementById('pauta-title').textContent = pautaName;

    // Disponibiliza dados globais para outros scripts
    document.body.dataset.currentPautaId = pautaId;
    document.body.dataset.pautaName = pautaName;
    document.body.dataset.userEmail = auth.currentUser.email;

    const pautaDoc = await getDoc(doc(db, "pautas", pautaId));
    if (!pautaDoc.exists()) return;

    const pautaData = pautaDoc.data();
    currentPautaData = pautaData;
    currentPautaOwnerId = pautaData.owner;
    isPautaClosed = pautaData.isClosed || false;
    
    const ordem = pautaData.ordemAtendimento || 'padrao';
    document.getElementById('logic-explanation-padrao').classList.toggle('hidden', ordem !== 'padrao');
    document.getElementById('logic-explanation-chegada').classList.toggle('hidden', ordem !== 'chegada');

    togglePautaLock(isPautaClosed);

    if (pautaType === 'agendado') {
         switchTab('agendamento');
         document.getElementById('tab-agendamento').classList.remove('hidden');
         document.getElementById('tab-avulso').classList.remove('hidden');
         document.getElementById('pauta-column').classList.remove('hidden');
    } else { // avulso
         switchTab('avulso');
         document.getElementById('tab-agendamento').classList.add('hidden');
         document.getElementById('tab-avulso').classList.remove('hidden');
         document.getElementById('pauta-column').classList.add('hidden');
    }

    setupRealtimeListener(pautaId);
    showScreen('app');
};

const deletePauta = async (pautaId) => {
    try {
        await deleteDoc(doc(db, "pautas", pautaId));
        showNotification("Pauta excluída com sucesso.", "info");
    } catch (error) {
        console.error("Erro ao excluir a pauta:", error);
        showNotification("Erro ao excluir a pauta.", "error");
    }
};

const createPautaCard = (docSnap) => {
    const pauta = docSnap.data();
    const card = document.createElement('div');
    card.className = "relative bg-white p-6 rounded-lg shadow-md flex flex-col justify-between h-full hover:shadow-xl transition-shadow cursor-pointer";
    
    if (pauta.owner === auth.currentUser?.uid) {
        const deleteButton = document.createElement('button');
        deleteButton.className = "absolute top-3 right-3 p-1 rounded-full text-gray-400 hover:bg-red-100 hover:text-red-600 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500";
        deleteButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>`;
        deleteButton.onclick = (event) => {
            event.stopPropagation(); 
            if (confirm(`Tem certeza que deseja apagar a pauta "${pauta.name}"?`)) {
                deletePauta(docSnap.id);
            }
        };
        card.appendChild(deleteButton);
    }
    
    card.innerHTML += `
        <div>
            <h3 class="font-bold text-xl mb-2">${pauta.name}</h3>
            <p class="text-gray-600">Membros: ${pauta.memberEmails?.length || 1}</p>
        </div>
        <div class="mt-4 pt-2 border-t border-gray-200">
            <p class="text-xs text-gray-500">Criada em: <strong>${new Date(pauta.createdAt).toLocaleDateString('pt-BR')}</strong></p>
        </div>
    `;
    card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        loadPauta(docSnap.id, pauta.name, pauta.type);
    });
    return card;
};

const showPautaSelectionScreen = (userId) => {
    const pautasList = document.getElementById('pautas-list');
    pautasList.innerHTML = '<p class="col-span-full text-center">Carregando pautas...</p>';
    const q = query(collection(db, "pautas"), where("members", "array-contains", userId));

    onSnapshot(q, (snapshot) => {
        pautasList.innerHTML = ''; 
        if (snapshot.empty) {
            pautasList.innerHTML = '<p class="col-span-full text-center text-gray-500">Nenhuma pauta encontrada. Crie uma para começar.</p>';
            return;
        }
        snapshot.docs.forEach((docSnap) => pautasList.appendChild(createPautaCard(docSnap)));
    }, (error) => {
        console.error("Erro ao buscar pautas:", error);
        pautasList.innerHTML = '<p class="col-span-full text-center text-red-500">Ocorreu um erro ao carregar as pautas.</p>';
    });

    showScreen('pautaSelection');
};

const handleAuthState = () => {
    onAuthStateChanged(auth, async (user) => {
        const existingLogoutBtn = document.getElementById('pending-logout-btn');
        if(existingLogoutBtn) existingLogoutBtn.remove();

        if (user) {
            const userDoc = await getDoc(doc(db, "users", user.uid));
            if (userDoc.exists() && userDoc.data().status === 'approved') {
                currentUserName = userDoc.data().name || user.email;
                document.getElementById('admin-btn-main').classList.toggle('hidden', userDoc.data().role !== 'admin');
                showPautaSelectionScreen(user.uid);
            } else {
                showScreen('loading');
                loadingText.innerHTML = 'Sua conta está pendente de aprovação. <br> Por favor, aguarde.';
                document.querySelector('.loader').style.display = 'none';
                const logoutBtn = document.createElement('button');
                logoutBtn.id = 'pending-logout-btn';
                logoutBtn.textContent = 'Sair';
                logoutBtn.className = 'mt-4 bg-gray-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-gray-700';
                logoutBtn.onclick = () => signOut(auth);
                loadingText.parentElement.appendChild(logoutBtn);
            }
        } else {
            showScreen('login');
        }
    });
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

const switchTab = (tabName) => {
    document.getElementById('tab-agendamento').classList.toggle('tab-active', tabName === 'agendamento');
    document.getElementById('tab-avulso').classList.toggle('tab-active', tabName === 'avulso');
    document.getElementById('is-scheduled-container').classList.toggle('hidden', tabName === 'avulso');
    document.getElementById('form-title').textContent = tabName === 'agendamento' ? "Adicionar Novo Agendamento" : "Adicionar Atendimento Avulso";
    
    document.querySelector('input[name="is-scheduled"][value="no"]').checked = true;
    document.querySelector('input[name="has-arrived"][value="no"]').checked = true;
    document.getElementById('scheduled-time-wrapper').classList.add('hidden');
    document.getElementById('arrival-time-wrapper').classList.add('hidden');
    
    if (tabName === 'avulso') {
        document.querySelector('input[name="has-arrived"][value="yes"]').checked = true;
        document.getElementById('arrival-time-wrapper').classList.remove('hidden');
        document.getElementById('arrival-time').value = new Date().toTimeString().slice(0, 5);
    }
    renderAssistedList();
};

const main = () => {
    try {
        const firebaseConfig = { apiKey: "AIzaSyCrLwXmkxgeVoB8TwRI7pplCVQETGK0zkE", authDomain: "pauta-ce162.firebaseapp.com", projectId: "pauta-ce162", storageBucket: "pauta-ce162.appspot.com", messagingSenderId: "87113750208", appId: "1:87113750208:web:4abba0024f4d4af699bf25" };
        const app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);
        handleAuthState();
    } catch (error) {
        console.error("Erro ao inicializar o Firebase: ", error);
        loadingText.textContent = 'Erro na configuração do Firebase.';
    }
};

document.addEventListener('DOMContentLoaded', () => {
    main();

    // Lógica de Login/Cadastro
    const loginTabBtn = document.getElementById('login-tab-btn');
    const registerTabBtn = document.getElementById('register-tab-btn');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');

    loginTabBtn.addEventListener('click', () => {
        loginForm.classList.remove('hidden');
        registerForm.classList.add('hidden');
        loginTabBtn.classList.add('border-green-600', 'text-green-600');
        registerTabBtn.classList.remove('border-green-600', 'text-green-600');
    });

    registerTabBtn.addEventListener('click', () => {
        registerForm.classList.remove('hidden');
        loginForm.classList.add('hidden');
        registerTabBtn.classList.add('border-green-600', 'text-green-600');
        loginTabBtn.classList.remove('border-green-600', 'text-green-600');
    });

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        const errorDiv = document.getElementById('auth-error');
        try {
            await signInWithEmailAndPassword(auth, email, password);
            errorDiv.classList.add('hidden');
        } catch (error) {
            errorDiv.textContent = 'Email ou senha inválidos.';
            errorDiv.classList.remove('hidden');
        }
    });

    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('register-name').value;
        const email = document.getElementById('register-email').value;
        const password = document.getElementById('register-password').value;
        const errorDiv = document.getElementById('auth-error');

        if (password.length < 6) {
            errorDiv.textContent = 'A senha deve ter pelo menos 6 caracteres.';
            errorDiv.classList.remove('hidden');
            return;
        }

        try {
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;
            await setDoc(doc(db, "users", user.uid), {
                name: name, email: email, uid: user.uid,
                status: 'pending', role: 'user', 
                createdAt: new Date().toISOString()
            });
            errorDiv.classList.add('hidden');
            showNotification('Conta criada! Aguardando aprovação do administrador.', 'info');
            loginTabBtn.click();
        } catch (error) {
            errorDiv.textContent = error.code === 'auth/email-already-in-use' ? 'Este email já está em uso.' : 'Erro ao criar a conta.';
            errorDiv.classList.remove('hidden');
        }
    });
    
    // Painel do Administrador
    document.getElementById('admin-btn-main').addEventListener('click', async () => {
        const adminModal = document.getElementById('admin-modal');
        adminModal.classList.remove('hidden');
        adminModal.innerHTML = `
            <div class="bg-white p-6 rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
                <div class="flex justify-between items-center mb-4 flex-shrink-0">
                    <h2 class="text-2xl font-bold text-gray-800">Painel do Administrador</h2>
                    <button id="close-admin-modal-btn" class="text-gray-400 hover:text-gray-600 text-3xl">&times;</button>
                </div>
                <div id="admin-user-list" class="overflow-y-auto">
                    <div class="text-center p-8"><div class="loader mx-auto"></div> Carregando usuários...</div>
                </div>
            </div>`;
        document.getElementById('close-admin-modal-btn').onclick = () => adminModal.classList.add('hidden');
        
        try {
            const usersSnapshot = await getDocs(collection(db, "users"));
            const users = usersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            
            const userListContainer = document.getElementById('admin-user-list');
            userListContainer.innerHTML = `
                <table class="w-full text-sm text-left text-gray-500">
                    <thead class="text-xs text-gray-700 uppercase bg-gray-50">
                        <tr><th scope="col" class="py-3 px-6">Nome</th><th scope="col" class="py-3 px-6">Email</th><th scope="col" class="py-3 px-6">Status</th><th scope="col" class="py-3 px-6">Ações</th></tr>
                    </thead>
                    <tbody></tbody>
                </table>`;
            const tbody = userListContainer.querySelector('tbody');
            users.sort((a, b) => (a.status === 'pending' ? -1 : 1)).forEach(user => {
                const tr = document.createElement('tr');
                tr.className = 'bg-white border-b';
                tr.innerHTML = `
                    <td class="py-4 px-6 font-medium text-gray-900">${user.name}</td>
                    <td class="py-4 px-6">${user.email}</td>
                    <td class="py-4 px-6"><span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${user.status === 'approved' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}">${user.status}</span></td>
                    <td class="py-4 px-6">
                        ${user.status === 'pending' ? `<button data-uid="${user.id}" class="approve-user-btn font-medium text-green-600 hover:underline mr-4">Aprovar</button>` : ''}
                        <button data-uid="${user.id}" class="delete-user-btn font-medium text-red-600 hover:underline">Deletar</button>
                    </td>`;
                tbody.appendChild(tr);
            });
        } catch (error) {
            console.error("Erro ao carregar usuários:", error);
            document.getElementById('admin-user-list').innerHTML = '<p class="text-red-500">Erro ao carregar usuários.</p>';
        }
    });

    document.getElementById('admin-modal').addEventListener('click', async (e) => {
        const uid = e.target.dataset.uid;
        if (!uid) return;
        if (e.target.classList.contains('approve-user-btn')) {
            if (confirm('Aprovar este usuário?')) {
                await updateDoc(doc(db, "users", uid), { status: 'approved' });
                showNotification('Usuário aprovado!');
                document.getElementById('admin-btn-main').click();
            }
        } else if (e.target.classList.contains('delete-user-btn')) {
            if (confirm('Deletar este usuário permanentemente?')) {
                await deleteDoc(doc(db, "users", uid));
                showNotification('Usuário deletado.');
                document.getElementById('admin-btn-main').click();
            }
        }
    });
    
    // Demais Listeners
    document.getElementById('tab-agendamento').addEventListener('click', () => switchTab('agendamento'));
    document.getElementById('tab-avulso').addEventListener('click', () => switchTab('avulso'));
    document.getElementById('logout-btn-main').addEventListener('click', () => signOut(auth));
    document.getElementById('logout-btn-app').addEventListener('click', () => signOut(auth));
    ['pauta-search', 'aguardando-search', 'atendidos-search', 'faltosos-search'].forEach(id => {
        document.getElementById(id).addEventListener('input', renderAssistedList);
    });
    
    document.getElementById('back-to-pautas-btn').addEventListener('click', () => {
        if (unsubscribeFromAttendances) unsubscribeFromAttendances();
        if (unsubscribeFromCollaborators) unsubscribeFromCollaborators();
        currentPautaId = null; allAssisted = []; colaboradores = [];
        showPautaSelectionScreen(auth.currentUser.uid);
    });

    document.body.addEventListener('click', async (e) => {
        const button = e.target.closest('button');
        if (!button) return;

        const id = button.dataset.id;
        const collectionRef = currentPautaId ? collection(db, "pautas", currentPautaId, "attendances") : null;
        
        // Ações que independem do ID
        if (button.id === 'add-assisted-btn') {
            const name = document.getElementById('assisted-name').value.trim();
            if (!name) return showNotification("O nome é obrigatório.", "error");
            
            const currentMode = document.getElementById('tab-agendamento').classList.contains('tab-active') ? 'agendamento' : 'avulso';
            const isScheduled = document.querySelector('input[name="is-scheduled"]:checked').value === 'yes';
            const hasArrived = document.querySelector('input[name="has-arrived"]:checked').value === 'yes';
            const scheduledTimeValue = isScheduled ? document.getElementById('scheduled-time').value : null;

            if (currentMode === 'agendamento' && isScheduled && !scheduledTimeValue) {
                return showNotification("Por favor, informe o horário agendado.", "error");
            }
            
            let arrivalDate = null;
            if (hasArrived) {
                const [h, m] = document.getElementById('arrival-time').value.split(':');
                arrivalDate = new Date();
                arrivalDate.setHours(h, m, 0, 0);
            }
            
            const newAssisted = getUpdatePayload({
                name,
                cpf: document.getElementById('assisted-cpf').value.trim(),
                subject: document.getElementById('assisted-subject').value.trim(),
                type: currentMode,
                status: hasArrived ? 'aguardando' : 'pauta',
                scheduledTime: scheduledTimeValue,
                arrivalTime: hasArrived ? arrivalDate.toISOString() : null,
                createdAt: new Date().toISOString()
            });

            await addDoc(collectionRef, newAssisted);
            showNotification("Assistido adicionado com sucesso!");
            document.getElementById('form-agendamento').reset();
            switchTab(currentMode);
        }
        
        if (button.classList.contains('toggle-details-btn')) {
            const details = button.closest('.relative').querySelector('.card-details');
            const icon = button.querySelector('svg');
            details.classList.toggle('hidden');
            icon.style.transform = details.classList.contains('hidden') ? 'rotate(180deg)' : 'rotate(0deg)';
        }

        if (id && collectionRef) {
            const docRef = doc(collectionRef, id);
            if (button.classList.contains('delegate-btn')) {
                assistedIdToHandle = id;
                const assisted = allAssisted.find(a => a.id === id);
                document.getElementById('delegation-assisted-name').textContent = assisted.name;
                
                const select = document.getElementById('delegation-collaborator-select');
                select.innerHTML = '<option value="">Selecione um colaborador</option>';
                colaboradores.forEach(c => {
                    const option = new Option(c.nome, c.email);
                    select.appendChild(option);
                });
                
                document.getElementById('delegation-modal').classList.remove('hidden');
            }
        }
        
        if (button.id === 'generate-delegation-link-btn') {
            const select = document.getElementById('delegation-collaborator-select');
            if (!select.value) return showNotification("Por favor, selecione um colaborador.", "error");
            
            const collaboratorName = select.selectedOptions[0].text;

            const baseUrl = window.location.origin + window.location.pathname.replace('index.html', '');
            const url = `${baseUrl}atendimento_externo.html?pautaId=${currentPautaId}&assistidoId=${assistedIdToHandle}&collaboratorName=${encodeURIComponent(collaboratorName)}`;

            document.getElementById('generated-link-text').value = url;
            document.getElementById('generated-link-container').classList.remove('hidden');
            
            navigator.clipboard.writeText(url).then(() => {
                showNotification('Link copiado para a área de transferência!', 'success');
            }, () => {
                showNotification('Não foi possível copiar o link automaticamente.', 'error');
            });
        }
        
        if(button.id === 'copy-delegation-link-btn') {
            const link = document.getElementById('generated-link-text').value;
            navigator.clipboard.writeText(link).then(() => showNotification('Link copiado!', 'info'));
        }
        
        if (button.id === 'cancel-delegation-btn') {
            document.getElementById('delegation-modal').classList.add('hidden');
            document.getElementById('generated-link-container').classList.add('hidden');
        }

    });
    
    // Lógica de Colaboradores
    const collaboratorForm = document.getElementById('collaborator-form');
    collaboratorForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const collaboratorData = {
            nome: document.getElementById('collaborator-name').value,
            email: document.getElementById('collaborator-email').value,
            telefone: document.getElementById('collaborator-phone').value,
            transporte: collaboratorForm.querySelector('input[name="transporte"]:checked').value,
            localEncontro: collaboratorForm.querySelector('input[name="localEncontro"]:checked')?.value || '',
            observacao: document.getElementById('collaborator-obs').value,
        };

        try {
            const collRef = collection(db, "pautas", currentPautaId, "collaborators");
            if (editCollaboratorId) {
                await updateDoc(doc(collRef, editCollaboratorId), collaboratorData);
                showNotification("Colaborador atualizado!");
            } else {
                await addDoc(collRef, { ...collaboratorData, presente: false, horario: '--:--' });
                showNotification("Colaborador adicionado!");
            }
            collaboratorForm.reset();
            editCollaboratorId = null;
        } catch (error) {
            showNotification("Erro ao salvar colaborador.", "error");
        }
    });

});

