import { api } from '../../services/apiClient.js';

// What-If simulator API. None of these calls writes to transactions, budgets or goals: only SavedSimulation rows are created/deleted.
export const getBaseline = (months = 3) => api.get('/simulations/baseline', { months }).then((r) => r.data);
export const listSimulations = () => api.get('/simulations').then((r) => r.data.simulations);
export const saveSimulation = ({ name, inputs, months }) => api.post('/simulations', { name, inputs, months }).then((r) => r.data.simulation);
export const getSimulation = (id) => api.get(`/simulations/${id}`).then((r) => r.data.simulation); // saved result + recalculated against today's data
export const deleteSimulation = (id) => api.del(`/simulations/${id}`);
