/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Norwegian flag–inspired theme palette
        // Red (sub-T, MP, race, primary CTAs)
        norwegian: {
          red: {
            50:  '#FCE9EC',
            100: '#F7C7CE',
            200: '#EE8A95',
            300: '#E25060',
            400: '#D32337',
            500: '#BA0C2F',  // primary red
            600: '#9C0A28',
            700: '#7B0820',
            800: '#5A0618',
            900: '#3D0410',
          },
          // Navy (easy, long, strength, neutral accents)
          navy: {
            50:  '#E6EAF1',
            100: '#C1CCDD',
            200: '#8FA1BD',
            300: '#5D769D',
            400: '#2F4F80',
            500: '#00205B',  // primary navy
            600: '#001B4E',
            700: '#001540',
            800: '#000F2F',
            900: '#00081F',
          },
        },
      },
    },
  },
  plugins: [],
};
