import { one, run, tx, flushCloud } from '../server/db.js';
import { validateTemplateContent } from '../server/marking.js';
import { generateHomework } from '../public/js/ai.js';

const LEVELS = ['words', 'sentences', 'paragraphs'];

const sets = [
  {
    topic: 'Daily Routines', icon: '⏰',
    words: [
      ['wake', '🛌', 'to stop sleeping'], ['brush', '🪥', 'to clean with a brush'],
      ['breakfast', '🥣', 'the first meal of the day'], ['school', '🏫', 'a place where pupils learn'],
      ['homework', '📝', 'schoolwork done at home'], ['sleep', '😴', 'to rest with your eyes closed'],
    ],
    sentences: ['I wake up at six o clock.', 'I brush my teeth every morning.', 'I eat breakfast before school.', 'I finish my homework after dinner.', 'I sleep at ten o clock.'],
    paragraph: 'Aina wakes up at six o clock every morning. She brushes her teeth and eats breakfast with her family. Then, she takes the bus to school. After dinner, she finishes her homework. She goes to sleep at ten o clock.',
    comprehension: [
      ['What time does Aina wake up?', 'Six o clock', ['Seven o clock', 'Ten o clock']],
      ['How does she travel to school?', 'By bus', ['By car', 'On foot']],
      ['When does she finish her homework?', 'After dinner', ['Before breakfast', 'At school']],
    ],
    writtenPrompt: 'Write two sentences about your daily routine.',
  },
  {
    topic: 'My Family', icon: '👪',
    words: [
      ['mother', '👩', 'a female parent'], ['father', '👨', 'a male parent'],
      ['sister', '👧', 'a female sibling'], ['brother', '👦', 'a male sibling'],
      ['grandmother', '👵', 'the mother of a parent'], ['grandfather', '👴', 'the father of a parent'],
    ],
    sentences: ['My mother is kind.', 'My father cooks dinner.', 'My sister likes to draw.', 'My brother plays football.', 'We visit our grandparents on Sunday.'],
    paragraph: 'Hafiz lives with his parents and his younger sister. His mother is a nurse, and his father is a cook. His sister likes to draw colourful pictures. On Sundays, the family visits their grandparents and shares lunch together.',
    comprehension: [
      ['Who lives with Hafiz?', 'His parents and younger sister', ['His uncle and cousin', 'His teacher and friend']],
      ['What is his mother’s job?', 'A nurse', ['A teacher', 'A cook']],
      ['What does the family do on Sundays?', 'They visit their grandparents', ['They go to school', 'They play football']],
    ],
    writtenPrompt: 'Write two sentences about someone in your family.',
  },
  {
    topic: 'Weather', icon: '☀️',
    words: [
      ['sunny', '☀️', 'bright with light from the sun'], ['rainy', '🌧️', 'having a lot of rain'],
      ['cloudy', '☁️', 'covered with clouds'], ['windy', '🌬️', 'having a lot of moving air'],
      ['stormy', '⛈️', 'having strong wind, rain, or thunder'], ['umbrella', '☂️', 'an object used to keep rain off'],
    ],
    sentences: ['The weather is sunny today.', 'I carry an umbrella on rainy days.', 'Dark clouds cover the sky.', 'The strong wind moves the trees.', 'We stay indoors during a storm.'],
    paragraph: 'The morning was sunny, so Mei Ling planned a picnic. At noon, dark clouds covered the sky and the wind became strong. Soon, heavy rain began to fall. Mei Ling opened her umbrella and hurried home. She decided to have her picnic indoors.',
    comprehension: [
      ['What did Mei Ling plan?', 'A picnic', ['A football match', 'A school trip']],
      ['What covered the sky at noon?', 'Dark clouds', ['Bright stars', 'A rainbow']],
      ['Where did she have her picnic?', 'Indoors', ['At the beach', 'In the park']],
    ],
    writtenPrompt: 'Describe today’s weather in two sentences.',
  },
  {
    topic: 'Hobbies', icon: '🎨',
    words: [
      ['reading', '📖', 'looking at and understanding written words'], ['drawing', '🎨', 'making a picture with a pen or pencil'],
      ['cycling', '🚲', 'riding a bicycle'], ['cooking', '🍳', 'preparing food to eat'],
      ['gardening', '🌱', 'growing and caring for plants'], ['swimming', '🏊', 'moving through water'],
    ],
    sentences: ['I enjoy reading adventure books.', 'Sara draws pictures after school.', 'We go cycling in the park.', 'My uncle teaches me to cook.', 'Swimming keeps the body active.'],
    paragraph: 'Kumar enjoys several hobbies. He reads adventure books on weekdays and goes cycling with his brother on Saturday. On Sunday morning, he helps his grandmother in the garden. His favourite hobby is drawing because he loves using bright colours.',
    comprehension: [
      ['What does Kumar read?', 'Adventure books', ['Comic strips', 'Recipe books']],
      ['Who cycles with Kumar?', 'His brother', ['His cousin', 'His father']],
      ['Why is drawing his favourite hobby?', 'He loves using bright colours', ['It is easy', 'His teacher tells him to draw']],
    ],
    writtenPrompt: 'Write two sentences about your favourite hobby and why you like it.',
  },
  {
    topic: 'Transportation', icon: '🚌',
    words: [
      ['bicycle', '🚲', 'a two-wheeled vehicle moved by pedals'], ['bus', '🚌', 'a large road vehicle for many passengers'],
      ['train', '🚆', 'a vehicle that travels on rails'], ['car', '🚗', 'a small road vehicle with four wheels'],
      ['boat', '🚤', 'a small vehicle that travels on water'], ['aeroplane', '✈️', 'a vehicle that flies in the sky'],
    ],
    sentences: ['I ride my bicycle to the shop.', 'The bus stops near my school.', 'The train arrives at the station.', 'My family travels by car.', 'An aeroplane flies above the clouds.'],
    paragraph: 'Farah and her family are travelling to Penang. They take a bus from their town to the railway station. Next, they board a train and find their seats. Farah enjoys watching farms and villages through the window. Her uncle meets them at the station in his car.',
    comprehension: [
      ['Where is Farah’s family travelling?', 'Penang', ['Johor', 'Sabah']],
      ['How do they reach the railway station?', 'By bus', ['By boat', 'By bicycle']],
      ['Who meets them at the station?', 'Her uncle', ['Her teacher', 'Her grandmother']],
    ],
    writtenPrompt: 'Write two sentences about how you travel to school or another place.',
  },
  {
    topic: 'Healthy Habits', icon: '🥗',
    words: [
      ['exercise', '🏃', 'physical activity that keeps the body fit'], ['water', '💧', 'a clear drink the body needs'],
      ['vegetables', '🥦', 'plants eaten as food'], ['fruit', '🍊', 'the sweet part of a plant that we eat'],
      ['hygiene', '🧼', 'keeping yourself and your surroundings clean'], ['rest', '🛌', 'time spent relaxing or sleeping'],
    ],
    sentences: ['Exercise keeps our bodies strong.', 'Drink enough water every day.', 'Vegetables are part of a healthy meal.', 'Wash your hands before eating.', 'A good night of rest helps us learn.'],
    paragraph: 'Daniel wants to stay healthy. He exercises for thirty minutes each day and drinks plenty of water. At mealtimes, he eats fruit and vegetables. He washes his hands before eating and brushes his teeth twice a day. He also sleeps for eight hours every night.',
    comprehension: [
      ['How long does Daniel exercise each day?', 'Thirty minutes', ['Ten minutes', 'Two hours']],
      ['What does he eat at mealtimes?', 'Fruit and vegetables', ['Only sweets', 'Only bread']],
      ['How many hours does he sleep?', 'Eight hours', ['Five hours', 'Twelve hours']],
    ],
    writtenPrompt: 'Write two healthy habits that you practise.',
  },
  {
    topic: 'Community Places', icon: '🏘️',
    words: [
      ['library', '📚', 'a place where people borrow books'], ['hospital', '🏥', 'a place where sick people receive care'],
      ['market', '🧺', 'a place where people buy and sell goods'], ['police station', '🚓', 'a building where police officers work'],
      ['post office', '📮', 'a place that handles letters and parcels'], ['playground', '🛝', 'an outdoor area where children play'],
    ],
    sentences: ['We borrow books from the library.', 'Doctors work at the hospital.', 'My mother buys vegetables at the market.', 'Police officers keep the community safe.', 'Children play at the playground.'],
    paragraph: 'Siti lives in a busy neighbourhood. There is a library beside the post office and a market across the road. On Saturday, Siti returns two books to the library. Then, she buys fruit at the market with her father. Before going home, they stop at the playground.',
    comprehension: [
      ['What is beside the post office?', 'The library', ['The hospital', 'The playground']],
      ['What does Siti return?', 'Two books', ['Two letters', 'Two bags']],
      ['Where do Siti and her father stop before going home?', 'The playground', ['The police station', 'The hospital']],
    ],
    writtenPrompt: 'Write two sentences about a useful place in your community.',
  },
  {
    topic: 'Our Environment', icon: '🌍',
    words: [
      ['recycle', '♻️', 'to turn used materials into new products'], ['rubbish', '🗑️', 'things that are thrown away'],
      ['pollution', '🏭', 'harmful waste that makes the environment dirty'], ['forest', '🌳', 'a large area covered with trees'],
      ['protect', '🛡️', 'to keep someone or something safe'], ['energy', '⚡', 'power used for light, heat, or movement'],
    ],
    sentences: ['We recycle paper and plastic.', 'Put rubbish in the correct bin.', 'Pollution harms people and animals.', 'Forests give homes to many animals.', 'Turn off lights to save energy.'],
    paragraph: 'The pupils in Class 6 Amanah want to protect the environment. They place paper, plastic, and cans in recycling bins. They also pick up rubbish around the school garden. Before leaving the classroom, they turn off the lights and fans. Their small actions help keep the school clean and save energy.',
    comprehension: [
      ['What do the pupils place in recycling bins?', 'Paper, plastic, and cans', ['Food and water', 'Books and pencils']],
      ['Where do they pick up rubbish?', 'Around the school garden', ['At the market', 'Inside the library']],
      ['Why do they turn off the lights and fans?', 'To save energy', ['To make the room dark', 'To leave school early']],
    ],
    writtenPrompt: 'Write two ways you can help protect the environment.',
  },
  {
    topic: 'Digital Life', icon: '💻',
    words: [
      ['computer', '💻', 'an electronic machine that stores and uses information'], ['keyboard', '⌨️', 'a set of keys used for typing'],
      ['internet', '🌐', 'a worldwide network that connects computers'], ['password', '🔐', 'a secret word used to enter an account'],
      ['message', '💬', 'information sent to another person'], ['screen', '🖥️', 'the part of a device that shows pictures and words'],
    ],
    sentences: ['I use a computer for my schoolwork.', 'The keyboard has many keys.', 'The internet helps us find information.', 'Never share your password with strangers.', 'Take regular breaks from the screen.'],
    paragraph: 'Amir uses a computer to research a science project. He asks his teacher which websites are safe and useful. Amir creates a strong password and keeps it private. After thirty minutes, he looks away from the screen and stretches. He knows that good digital habits keep him safe and healthy.',
    comprehension: [
      ['Why does Amir use a computer?', 'To research a science project', ['To buy a bicycle', 'To watch a film']],
      ['Who helps him choose safe websites?', 'His teacher', ['His neighbour', 'His brother']],
      ['What does Amir do after thirty minutes?', 'He looks away and stretches', ['He shares his password', 'He turns up the sound']],
    ],
    writtenPrompt: 'Write two rules for using digital devices safely.',
  },
  {
    topic: 'Celebrations', icon: '🎉',
    words: [
      ['celebrate', '🎊', 'to do something special for an important event'], ['family', '👪', 'a group of people related to one another'],
      ['decorate', '🎀', 'to make a place look attractive for a special event'], ['gift', '🎁', 'something given to another person'],
      ['meal', '🍽️', 'food eaten at a particular time'], ['tradition', '🪔', 'a custom passed from one generation to another'],
    ],
    sentences: ['Families celebrate special days together.', 'We decorate the house with colourful lights.', 'I made a gift for my friend.', 'Everyone shared a delicious meal.', 'Each celebration has its own traditions.'],
    paragraph: 'Priya’s family is preparing for a special celebration. In the morning, they clean and decorate the house with colourful flowers. Priya helps her mother prepare a delicious meal. In the evening, their relatives arrive with gifts. Everyone eats together and listens to stories about family traditions.',
    comprehension: [
      ['What does the family use to decorate the house?', 'Colourful flowers', ['Paper boats', 'School bags']],
      ['Who does Priya help?', 'Her mother', ['Her teacher', 'Her cousin']],
      ['What do they listen to?', 'Stories about family traditions', ['The weather report', 'A lesson about trains']],
    ],
    writtenPrompt: 'Write two sentences about a celebration or tradition you enjoy.',
  },
];

function wordObjects(entries) {
  return entries.map(([word, picture, meaning]) => ({ word, picture, meaning }));
}

function comprehensionObjects(entries) {
  return entries.map(([q, a, wrongs]) => ({ q, a, wrongs }));
}

let createdSets = 0;
let updatedSets = 0;
let writtenTemplates = 0;

tx(() => {
  for (const spec of sets) {
    let set = one('SELECT id FROM template_sets WHERE topic = ? COLLATE NOCASE', spec.topic);
    if (set) {
      updatedSets += 1;
      run('UPDATE template_sets SET icon = ?, is_demo = 0 WHERE id = ?', spec.icon, set.id);
    } else {
      const id = run('INSERT INTO template_sets (topic, icon, is_demo) VALUES (?,?,0)', spec.topic, spec.icon).lastInsertRowid;
      set = { id };
      createdSets += 1;
    }

    for (const level of LEVELS) {
      const generated = generateHomework({
        topic: spec.topic,
        level,
        words: wordObjects(spec.words),
        sentences: spec.sentences,
        paragraph: spec.paragraph,
        comprehension: comprehensionObjects(spec.comprehension),
        writtenPrompt: spec.writtenPrompt,
      });
      if (generated.error) throw new Error(`${spec.topic} (${level}): ${generated.error}`);
      const validationError = validateTemplateContent(generated.content);
      if (validationError) throw new Error(`${spec.topic} (${level}): ${validationError}`);

      const existing = one('SELECT id FROM templates WHERE set_id = ? AND level = ?', set.id, level);
      if (existing) {
        run(
          'UPDATE templates SET title = ?, activity_type = ?, estimated_minutes = ?, content = ?, is_demo = 0 WHERE id = ?',
          generated.title, generated.activityType, generated.minutes, JSON.stringify(generated.content), existing.id,
        );
      } else {
        run(
          'INSERT INTO templates (set_id, level, title, activity_type, estimated_minutes, content, is_demo) VALUES (?,?,?,?,?,?,0)',
          set.id, level, generated.title, generated.activityType, generated.minutes, JSON.stringify(generated.content),
        );
      }
      writtenTemplates += 1;
    }
  }
});

await flushCloud();
console.log(JSON.stringify({ createdSets, updatedSets, writtenTemplates, topics: sets.map((set) => set.topic) }, null, 2));
