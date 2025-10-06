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
        if (data.length === 0) el.innerHTML = `<p class="text-gray-500 text-center p-4">Nenhum registro.</p>`;
        else data.forEach((item, index) => el.appendChild(generator(item, index)));
    };

    render(lists.pauta, filtered.pauta, a => {
        const card = document.createElement('div');
        card.className = 'relative bg-gray-50 p-4 rounded-lg shadow-sm border';
        card.innerHTML = `
            <button data-id="${a.id}" class="delete-btn absolute top-2 right-2 text-gray-400 hover:text-red-600 p-1 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" class="pointer-events-none" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M11 1.5v1h3.5a.5.5 0 0 1 0 1h-.538l-.853 10.66A2 2 0 0 1 11.115 16h-6.23a2 2 0 0 1-1.994-1.84L2.038 3.5H1.5a.5.5 0 0 1 0-1H5v-1A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5zM4.5 5.029l.5 8.5a.5.5 0 1 0 .998-.06l-.5-8.5a.5.5 0 1 0-.998.06zm3 0l.5 8.5a.5.5 0 1 0 .998-.06l-.5-8.5a.5.5 0 1 0-.998.06zm3 .5a.5.5 0 0 0-1 0v8.5a.5.5 0 0 0 1 0v-8.5z"/></svg></button>
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
            <button data-id="${a.id}" class="delete-btn absolute top-2 right-2 text-gray-400 hover:text-red-600 p-1 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" class="pointer-events-none" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M11 1.5v1h3.5a.5.5 0 0 1 0 1h-.538l-.853 10.66A2 2 0 0 1 11.115 16h-6.23a2 2 0 0 1-1.994-1.84L2.038 3.5H1.5a.5.5 0 0 1 0-1H5v-1A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5zm-5 0v1h4v-1a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5zM4.5 5.029l.5 8.5a.5.5 0 1 0 .998-.06l-.5-8.5a.5.5 0 1 0-.998.06zm3 0l.5 8.5a.5.5 0 1 0 .998-.06l-.5-8.5a.5.5 0 1 0-.998.06zm3 .5a.5.5 0 0 0-1 0v8.5a.5.5 0 0 0 1 0v-8.5z"/></svg></button>
            <p class="font-bold text-lg">${index + 1}. ${a.name}</p>
            <p class="text-sm">Assunto: <strong>${a.subject}</strong></p>
            <p class="text-sm text-gray-500">${arrival}</p>
            <button data-id="${a.id}" class="view-details-btn text-indigo-600 hover:text-indigo-800 text-sm hover:underline font-semibold py-1">Ver Detalhes</button>
            <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
                <button data-id="${a.id}" class="attend-btn col-span-2 bg-blue-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-blue-600">Atender</button>
                <button data-id="${a.id}" class="edit-assisted-btn bg-gray-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-gray-600">Editar</button>
                ${a.priority !== 'URGENTE' ? `<button data-id="${a.id}" class="priority-btn bg-red-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-red-600">Prioridade</button>` : ''}
            </div>
            ${returnToPautaBtn ? `<div class="mt-2">${returnToPautaBtn}</div>` : ''}
            ${a.lastActionBy ? `<div class="text-xs text-right text-gray-400 mt-2 pt-2 border-t">Última ação por: <strong>${a.lastActionBy}</strong></div>` : ''}
        `;
        return card;
    });
    
    render(lists.emAtendimento, filtered.emAtendimento, a => {
        const card = document.createElement('div');
        card.className = `relative bg-blue-50 p-4 rounded-lg shadow-sm border-l-4 border-blue-400`;
        card.innerHTML = `
            <p class="font-bold text-lg">${a.name}</p>
            <p class="text-sm">Assunto: <strong>${a.subject}</strong></p>
            <p class="text-sm mt-1">Atendendo por: <strong class="text-blue-700">${a.attendant || 'A definir'}</strong></p>
            <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
                <button data-id="${a.id}" class="finalize-btn bg-green-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-green-600">Finalizar</button>
                <button data-id="${a.id}" class="delegate-btn bg-purple-100 text-purple-700 font-semibold py-2 px-3 rounded-lg hover:bg-purple-200">Delegar Finalização</button>
                <button data-id="${a.id}" class="return-to-aguardando-btn col-span-2 bg-yellow-500 text-white font-semibold py-2 px-3 rounded-lg hover:bg-yellow-600 mt-1">Voltar p/ Fila</button>
            </div>
        `;
        return card;
    });

    render(lists.finalizado, filtered.finalizado, a => {
        const card = document.createElement('div');
        card.className = 'relative bg-green-50 p-4 rounded-lg shadow-sm border-green-200';
        const totalAssuntos = 1 + (a.demandas?.quantidade || 0);
        const demandasInfo = a.demandas?.descricoes?.length > 0 ? `<div class="mt-2 text-xs bg-gray-100 p-2 rounded"><strong class="text-gray-700">Demandas Adicionais (${a.demandas.quantidade || 0}):</strong><ul class="list-disc list-inside pl-2 text-gray-600">${a.demandas.descricoes.map(d => `<li>${d}</li>`).join('')}</ul></div>` : '';
        const finalizadoExternamente = a.finalizadoPeloColaborador ? `<span class="text-xs font-bold text-blue-600 bg-blue-100 px-2 py-1 rounded-full">Finalizado por Colaborador</span>` : '';
        card.innerHTML = `
            <div class="flex justify-between items-start">
                <p class="font-bold text-lg">${a.name} ${totalAssuntos > 1 ? `<span class="text-sm font-medium text-green-600">(${totalAssuntos} assuntos)</span>` : ''}</p>
                <button class="toggle-details-btn text-gray-500 hover:text-gray-800 p-1">
                     <svg class="pointer-events-none" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>
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
                    <button data-id="${a.id}" class="return-to-em-atendimento-btn bg-yellow-500 text-white font-semibold py-1 px-3 rounded-lg hover:bg-yellow-600 text-xs">Reabrir Atendimento</button>
                </div>
            </div>`;
        return card;
    });

    render(lists.faltoso, filtered.faltoso, a => {
        const card = document.createElement('div');
        card.className = 'relative bg-red-50 p-4 rounded-lg shadow-sm border-red-200';
        card.innerHTML = `
            <button data-id="${a.id}" class="delete-btn absolute top-2 right-2 text-gray-400 hover:text-red-600 p-1 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" class="pointer-events-none" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M11 1.5v1h3.5a.5.5 0 0 1 0 1h-.538l-.853 10.66A2 2 0 0 1 11.115 16h-6.23a2 2 0 0 1-1.994-1.84L2.038 3.5H1.5a.5.5 0 0 1 0-1H5v-1A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5zM6 6.5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0v-6a.5.5 0 0 1 .5-.5zm3 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0v-6a.5.5 0 0 1 .5-.5zm-5 1a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1h-6z"/></svg></button>
            <p class="font-bold text-lg">${a.name}</p>
            <div class="mt-2 space-y-2">
                ${a.cpf ? `<p class="text-sm">CPF: <strong>${a.cpf}</strong></p>` : ''}
                <p class="text-sm">Assunto: <strong>${a.subject}</strong></p>
                <p class="text-sm">Agendado: <strong>${a.scheduledTime}</strong></p>
                <div class="mt-3">
                    <button data-id="${a.id}" class="return-to-pauta-from-faltoso-btn w-full bg-gray-500 text-white font-semibold py-1 rounded-lg hover:bg-gray-600 text-xs">Reverter para Pauta</button>
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
    if (unsubscribeFromCollaborators) unsubscribeFromCollaborators();
    
    const attendanceCollectionRef = collection(db, "pautas", pautaId, "attendances");
    unsubscribeFromAttendances = onSnapshot(attendanceCollectionRef, (snapshot) => {
        allAssisted = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderAssistedList();
    }, (error) => console.error("Erro no listener de atendimentos: ", error));

    const collaboratorsCollectionRef = collection(db, "pautas", pautaId, "collaborators");
    unsubscribeFromCollaborators = onSnapshot(collaboratorsCollectionRef, (snapshot) => {
        colaboradores = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        colaboradores.sort((a, b) => a.nome.localeCompare(b.nome)); 
    }, (error) => console.error("Erro no listener de colaboradores: ", error));
};

const loadPauta = async (pautaId, pautaName, pautaType) => {
    currentPautaId = pautaId;
    document.getElementById('pauta-title').textContent = pautaName;

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
    } else {
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
    card.dataset.pautaId = docSnap.id;
    card.dataset.pautaName = pauta.name;
    card.dataset.pautaType = pauta.type;
    
    if (pauta.owner === auth.currentUser?.uid) {
        const deleteButton = document.createElement('button');
        deleteButton.className = "delete-pauta-btn absolute top-3 right-3 p-1 rounded-full text-gray-400 hover:bg-red-100 hover:text-red-600 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500";
        deleteButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>`;
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

    const datalist = document.getElementById('subjects-list');
    flatSubjects.forEach(subject => {
        const option = document.createElement('option');
        option.value = subject.value;
        datalist.appendChild(option);
    });

    // --- EVENT LISTENER CENTRALIZADO ---
    document.body.addEventListener('click', async (e) => {
        const button = e.target.closest('button');
        if (!button) {
            // Check for other clickable elements like links
            if (e.target.closest('a#forgot-password-link')) {
                 e.preventDefault();
                const email = prompt("Por favor, digite seu email para redefinir a senha:");
                if (email) {
                    sendPasswordResetEmail(auth, email)
                        .then(() => showNotification("Email de redefinição de senha enviado!", "success"))
                        .catch((error) => showNotification("Erro ao enviar email. Verifique se o email está correto.", "error"));
                }
            }
             if (e.target.closest('a#privacy-policy-link')) {
                e.preventDefault();
                document.getElementById('privacy-policy-modal').classList.remove('hidden');
            }
            return;
        };

        const id = button.dataset.id;
        const uid = button.dataset.uid;
        
        // Ações que não dependem de um 'id' de assistido
        switch (button.id) {
            case 'login-tab-btn':
                document.getElementById('login-form').classList.remove('hidden');
                document.getElementById('register-form').classList.add('hidden');
                button.classList.add('border-green-600', 'text-green-600');
                document.getElementById('register-tab-btn').classList.remove('border-green-600', 'text-green-600');
                return;
            case 'register-tab-btn':
                document.getElementById('register-form').classList.remove('hidden');
                document.getElementById('login-form').classList.add('hidden');
                button.classList.add('border-green-600', 'text-green-600');
                document.getElementById('login-tab-btn').classList.remove('border-green-600', 'text-green-600');
                return;
            case 'actions-toggle':
                const panel = document.getElementById('actions-panel');
                const arrow = document.getElementById('actions-arrow');
                panel.classList.toggle('opacity-0');
                panel.classList.toggle('scale-90');
                panel.classList.toggle('pointer-events-none');
                arrow.classList.toggle('rotate-180');
                return;
            case 'toggle-logic-btn-padrao':
                 const explanation = document.getElementById('logic-explanation-padrao-content');
                 const isHidden = explanation.classList.toggle('hidden');
                 button.textContent = isHidden ? 'Por que esta ordem é justa? (Clique para expandir)' : 'Ocultar explicação';
                return;
             case 'download-pdf-btn':
                const { jsPDF } = window.jspdf;
                const docPDF = new jsPDF();
                const finalizados = allAssisted.filter(a => a.status === 'atendido');

                if (finalizados.length === 0) {
                    showNotification("Não há atendimentos finalizados para gerar o relatório.", "info");
                    return;
                }
                
                docPDF.text(`Relatório de Atendimentos Finalizados - ${currentPautaData.name}`, 14, 22);
                const tableColumn = ["#", "Nome", "CPF", "Assunto Principal", "Atendente", "Finalizado"];
                const tableRows = [];
                finalizados.forEach((item, index) => {
                    const rowData = [
                        index + 1, item.name, item.cpf || 'N/A', item.subject,
                        item.attendant || 'N/A',
                        new Date(item.attendedTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                    ];
                    tableRows.push(rowData);
                });
                docPDF.autoTable(tableColumn, tableRows, { startY: 30 });
                docPDF.save(`relatorio_finalizados_${currentPautaData.name.replace(/\s/g, '_')}.pdf`);
                return;
            
        }

        // --- Ações de Clique em Cards ---
        const pautaCard = e.target.closest('[data-pauta-id]');
        if (pautaCard && !button.classList.contains('delete-pauta-btn')) {
            const { pautaId, pautaName, pautaType } = pautaCard.dataset;
            loadPauta(pautaId, pautaName, pautaType);
            return;
        }

        if (button.classList.contains('delete-pauta-btn')) {
            const card = button.closest('[data-pauta-id]');
            if (confirm(`Tem certeza que deseja apagar a pauta "${card.dataset.pautaName}"?`)) {
                deletePauta(card.dataset.pautaId);
            }
            return;
        }

        if(button.classList.contains('toggle-details-btn')) {
             const details = button.closest('.relative').querySelector('.card-details');
             const icon = button.querySelector('svg');
             details.classList.toggle('hidden');
             icon.style.transform = details.classList.contains('hidden') ? 'rotate(180deg)' : 'rotate(0deg)';
             return;
        }

        const collectionRef = currentPautaId ? collection(db, "pautas", currentPautaId, "attendances") : null;
        if (!collectionRef) return;
        const docRef = id ? doc(collectionRef, id) : null;

        // Ações com 'id' de assistido
        if (id && docRef) {
            assistedIdToHandle = id;
            if (button.classList.contains('attend-btn')) {
                const attendantInput = document.getElementById('attendant-name');
                attendantInput.value = '';
                const datalist = document.getElementById('collaborators-list');
                datalist.innerHTML = '';
                colaboradores.forEach(c => {
                    const option = new Option(c.nome, c.nome); // Usar nome como valor
                    datalist.appendChild(option);
                });
                document.getElementById('attendant-modal').classList.remove('hidden');
            } else if (button.classList.contains('confirm-attendant-btn')) {
                const attendantName = document.getElementById('attendant-name').value.trim();
                await updateDoc(doc(collectionRef, assistedIdToHandle), getUpdatePayload({ status: 'em-atendimento', attendant: attendantName }));
                document.getElementById('attendant-modal').classList.add('hidden');
            } else if (button.classList.contains('delegate-btn')) {
                 const assisted = allAssisted.find(a => a.id === id);
                 document.getElementById('delegation-assisted-name').textContent = assisted.name;
                 const select = document.getElementById('delegation-collaborator-select');
                 select.innerHTML = '<option value="">Selecione um colaborador</option>';
                 colaboradores.forEach(c => select.add(new Option(c.nome, c.email)));
                 document.getElementById('delegation-modal').classList.remove('hidden');
            } else if (button.classList.contains('finalize-btn')) {
                 if (confirm("Confirmar a finalização deste atendimento?")) {
                    await updateDoc(docRef, getUpdatePayload({ status: 'atendido', attendedTime: new Date().toISOString() }));
                    showNotification("Atendimento finalizado com sucesso!");
                 }
            } else if(button.classList.contains('return-to-em-atendimento-btn')) {
                 await updateDoc(docRef, getUpdatePayload({ status: 'em-atendimento', attendedTime: null }));
                 showNotification("Atendimento reaberto.");
            }
            // ... outras ações com 'id' ...
        }

        // Geração do Link
        if (button.id === 'generate-delegation-link-btn') {
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
        
    });

    // Event listeners para formulários
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = e.target.elements['login-email'].value;
        const password = e.target.elements['login-password'].value;
        try {
            await signInWithEmailAndPassword(auth, email, password);
        } catch (error) {
            document.getElementById('auth-error').textContent = 'Email ou senha inválidos.';
            document.getElementById('auth-error').classList.remove('hidden');
        }
    });

    document.getElementById('register-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        // ... (lógica de registro como estava antes)
    });
});

