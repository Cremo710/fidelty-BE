// Register TypeScript compiler
import { register } from 'esbuild-register/dist/node';

// Configura TypeScript
register({
  // Opzioni di configurazione di TypeScript
  // Puoi aggiungere qui le tue opzioni personalizzate
});

// Importa il file principale
import('./src/index.ts')
  .then(() => console.log('✅ Server avviato con successo!'))
  .catch(err => {
    console.error('❌ Errore durante l\'avvio del server:', err);
    process.exit(1);
  });
